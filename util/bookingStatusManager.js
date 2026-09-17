import cron from 'node-cron';
import prisma from './prisma.js';
import Logger from './logger.js';
import { createNotification } from './notificationHelper.js';
import { renderNotification, NOTIFICATION_TYPES } from './notificationTemplates.js';
import { parseTimeToMinutes } from './slots.js';
import { getISTDate } from './time.js';

/**
 * How long after its slot an un-started booking is written off.
 *
 * Shared by the activation and expiry jobs deliberately: activation stays open
 * right up to this line and expiry begins exactly at it, so there is no gap in
 * which a booking is eligible for neither.
 */
const EXPIRY_AFTER_MINUTES = 30;

/**
 * How long a vendor has to accept or reject a request before it is auto-declined.
 *
 * This was hard-coded to FIVE MINUTES, which is why the vendor homepage's
 * pending list looked broken: this cron runs every minute, so any request the
 * vendor did not answer within five minutes was already `cancelled` by the time
 * they opened the app. The list was not failing to render -- there was
 * genuinely nothing pending left to render. Every client-side attempt to "stop
 * hiding requests older than 5 minutes" was fighting a row the backend had
 * already closed.
 *
 * Five minutes is not a realistic window for someone running a workshop. The
 * default is now 30 minutes, and it is configurable so the number can be tuned
 * without a code change. Set BOOKING_PENDING_TIMEOUT_MINUTES to override.
 *
 * Note this is deliberately the same value as EXPIRY_AFTER_MINUTES but a
 * SEPARATE constant: that one is how long after its slot an accepted job is
 * written off, this one is how long a vendor has to answer at all. They happen
 * to match today; tying them together would silently move one when the other
 * is tuned.
 */
const PENDING_TIMEOUT_MINUTES = Number(
  process.env.BOOKING_PENDING_TIMEOUT_MINUTES || 30
);

/**
 * Booking Status Manager
 * Handles automatic time-based status transitions for bookings
 */
class BookingStatusManager {
  constructor() {
    this.isRunning = false;
  }

  /**
   * Start the booking status monitoring service
   */
  start() {
    if (this.isRunning) {
      Logger.info('Booking Status Manager is already running');
      return;
    }

    Logger.info('Starting Booking Status Manager...');

    // Run every minute to check for status updates including 5-min pending timeouts
    cron.schedule('*/1 * * * *', async () => {
      try {
        await this.processBookingStatusUpdates();
      } catch (error) {
        Logger.error('Error in booking status update cron job:', error);
      }
    });

    // Also run immediately on startup
    this.processBookingStatusUpdates().catch(error => {
      Logger.error('Error in initial booking status update:', error);
    });

    this.isRunning = true;
    Logger.info('Booking Status Manager started successfully');
  }

  /**
   * Process all bookings that need status updates based on time
   */
  async processBookingStatusUpdates() {
    const now = new Date();
    Logger.info(`Processing booking status updates at ${now.toISOString()}`);

    try {
      // 0. Handle bookings pending vendor approval for > 5 mins
      await this.handlePendingBookingsTimeout(now);

      // 1. Move confirmed/scheduled bookings to in_progress when time arrives
      await this.activateBookingsAtScheduledTime(now);

      // 2. Handle expired bookings (past scheduled time without being started)
      await this.handleExpiredBookings(now);

    } catch (error) {
      Logger.error('Error processing booking status updates:', error);
    }
  }

  /**
   * Move bookings to "in_progress" when their scheduled time arrives
   */
  async activateBookingsAtScheduledTime(now) {
    try {
      // Find bookings that are confirmed/scheduled and their time has arrived.
      // Bounded to "yesterday (IST) onwards" -- a booking older than that has
      // long since either activated or expired (EXPIRY_AFTER_MINUTES is only
      // 30 minutes), so scanning further back just makes every once-a-minute
      // tick walk the entire booking history for nothing.
      const bookingsToActivate = await prisma.booking.findMany({
        where: {
          status: {
            in: ['confirmed', 'scheduled']
          },
          vendor_status: 'accepted',
          booking_date: { gte: this.getActivationLowerBound(now) },
        },
        include: { service: true },
      });

      let activatedCount = 0;

      // Debug: Log first booking data structure
      if (bookingsToActivate.length > 0) {
        const firstBooking = bookingsToActivate[0];
        Logger.info(`Sample booking data - ID: ${firstBooking.id}, Date: ${firstBooking.booking_date} (type: ${typeof firstBooking.booking_date}), Time: ${firstBooking.booking_time} (type: ${typeof firstBooking.booking_time})`);
      }

      for (const booking of bookingsToActivate) {
        try {
          // Parse booking date and time
          const bookingDateTime = this.parseBookingDateTime(booking.booking_date, booking.booking_time);

          if (!bookingDateTime) {
            Logger.warn(`Invalid date/time for booking ${booking.id} - Date: ${booking.booking_date}, Time: ${booking.booking_time}`);
            continue;
          }

          const timeDiff = now.getTime() - bookingDateTime.getTime();
          const minutesDiff = timeDiff / (1000 * 60);

          // Activate once the slot has ACTUALLY arrived, and stay activatable
          // until the expiry job takes over.
          //
          // This was `minutesDiff >= -5 && minutesDiff <= 5`, which was wrong at
          // both ends. The -5 meant a booking flipped to in_progress five
          // minutes BEFORE its slot, so the DB itself claimed a job was ongoing
          // before it began -- no amount of frontend correctness can hide that.
          // The +5 upper bound was worse: it made activation a five-minute
          // window this once-a-minute cron had to land inside. Miss it (process
          // restart, a slow tick, a DB hiccup) and the booking was never
          // activated at all -- and 25 minutes later handleExpiredBookings
          // cancelled it instead. A confirmed booking silently became cancelled
          // purely because a cron tick was late.
          //
          // The bound is now EXPIRY_AFTER_MINUTES so the two jobs share one
          // boundary and cannot disagree about which owns a given booking.
          if (minutesDiff >= 0 && minutesDiff <= EXPIRY_AFTER_MINUTES) {
            await this.activateBooking(booking);
            activatedCount++;
          }
        } catch (error) {
          Logger.error(`Error processing booking ${booking.id}:`, error);
        }
      }

      if (activatedCount > 0) {
        Logger.info(`Activated ${activatedCount} bookings at scheduled time`);
      }

    } catch (error) {
      Logger.error('Error activating bookings at scheduled time:', error);
    }
  }

  /**
   * Handle bookings that have passed their scheduled time without being started
   */
  async handleExpiredBookings(now) {
    try {
      // Find confirmed/scheduled bookings that are past their time. Same
      // lower bound as activateBookingsAtScheduledTime -- see its comment.
      const expiredBookings = await prisma.booking.findMany({
        where: {
          status: {
            in: ['confirmed', 'scheduled']
          },
          vendor_status: 'accepted',
          booking_date: { gte: this.getActivationLowerBound(now) },
        },
        include: { service: true },
      });

      let expiredCount = 0;

      for (const booking of expiredBookings) {
        try {
          // Parse booking date and time
          const bookingDateTime = this.parseBookingDateTime(booking.booking_date, booking.booking_time);

          if (!bookingDateTime) {
            Logger.warn(`Invalid date/time for booking ${booking.id} - Date: ${booking.booking_date}, Time: ${booking.booking_time}`);
            continue;
          }

          const timeDiff = now.getTime() - bookingDateTime.getTime();
          const minutesDiff = timeDiff / (1000 * 60);

          // Same boundary the activation job stops at, so a booking is always
          // owned by exactly one of the two jobs and never falls between them.
          if (minutesDiff > EXPIRY_AFTER_MINUTES) {
            await this.expireBooking(booking);
            expiredCount++;
          }
        } catch (error) {
          Logger.error(`Error processing expired booking ${booking.id}:`, error);
        }
      }

      if (expiredCount > 0) {
        Logger.info(`Expired ${expiredCount} bookings that passed scheduled time`);
      }

    } catch (error) {
      Logger.error('Error handling expired bookings:', error);
    }
  }

  /**
   * Handle bookings pending vendor approval for more than 5 minutes
   */
  async handlePendingBookingsTimeout(now) {
    try {
      // Only fetch rows that are ALREADY past the deadline, rather than
      // loading every pending booking in history every single minute and
      // filtering in JS.
      const cutoff = new Date(now.getTime() - PENDING_TIMEOUT_MINUTES * 60 * 1000);
      const pendingBookings = await prisma.booking.findMany({
        where: {
          vendor_status: 'pending',
          status: 'pending',
          createdAt: { lte: cutoff },
        },
        include: { service: true },
      });

      let declinedCount = 0;

      for (const booking of pendingBookings) {
        try {
          {
            // The query above already restricted this to rows past the
            // deadline, so there is no per-row time check left to do.
            // service comes from the findMany's include -- a per-row
            // findUnique here ran once per booking on every minute-tick
            // (audit #53/#133); one join up front does the same work once.
            const service = booking.service;

            // updateMany with the precondition repeated in the WHERE, not
            // update({ where: { id } }).
            //
            // The findMany above selected rows that were pending at that moment,
            // but the write happened unconditionally, so a vendor who accepted in
            // the gap between the read and this line had their acceptance silently
            // overwritten to rejected/cancelled. The window is small per row, but
            // this loop runs every minute over every expired booking, and the
            // visible result was a job the vendor had just taken being cancelled
            // out from under both parties.
            //
            // count === 0 means the vendor got there first: skip the rest of this
            // iteration rather than telling both sides the request expired.
            const declined = await prisma.booking.updateMany({
              where: {
                id: booking.id,
                vendor_status: 'pending',
                status: 'pending',
              },
              data: {
                vendor_status: 'rejected',
                status: 'cancelled',
                updatedAt: new Date(),
                notes: (booking.notes || '') + `\n[Auto-declined: Vendor did not accept within ${PENDING_TIMEOUT_MINUTES} minutes]`
              }
            });

            if (declined.count === 0) {
              Logger.info(`Booking ${booking.id} was accepted while the auto-decline was running; leaving it alone.`);
              continue;
            }

            // Notify user
            await createNotification({
              userId: booking.userId,
              ...renderNotification(NOTIFICATION_TYPES.BOOKING_AUTO_DECLINED, {
                serviceName: service?.name,
                bookingId: booking.id,
              }),
            });

            // Notify vendor - fetch vendor id from service
            if (service) {
              await createNotification({
                userId: service.vendorId,
                ...renderNotification(NOTIFICATION_TYPES.BOOKING_REQUEST_EXPIRED, {
                  serviceName: service.name,
                  bookingId: booking.id,
                }),
              });
            }

            declinedCount++;
            Logger.info(`Auto-declined booking ${booking.id} after ${PENDING_TIMEOUT_MINUTES} minutes of inactivity`);
          }
        } catch (error) {
          Logger.error(`Error processing pending timeout for booking ${booking.id}:`, error);
        }
      }

      if (declinedCount > 0) {
        Logger.info(`Auto-declined ${declinedCount} bookings due to vendor inactivity`);
      }

    } catch (error) {
      Logger.error('Error handling pending bookings timeout:', error);
    }
  }

  /**
   * Activate a booking by changing status to in_progress
   */
  async activateBooking(booking) {
    try {
      // booking.service comes from the caller's findMany include -- see the
      // note there (audit #53/#133) for why this is no longer a fresh
      // per-booking lookup.
      const service = booking.service;

      // Update booking status
      await prisma.booking.update({
        where: { id: booking.id },
        data: {
          status: 'in_progress',
          updatedAt: new Date()
        }
      });

      // Create notification for user
      await createNotification({
        userId: booking.userId,
        ...renderNotification(NOTIFICATION_TYPES.SERVICE_STARTED, {
          serviceName: service?.name,
          bookingId: booking.id,
        }),
      });

      // Create notification for vendor
      if (service) {
        await createNotification({
          userId: service.vendorId,
          ...renderNotification(NOTIFICATION_TYPES.SERVICE_TIME_ARRIVED, {
            serviceName: service.name,
            bookingId: booking.id,
          }),
        });
      }

      Logger.info(`Activated booking ${booking.id} - moved to in_progress status`);

    } catch (error) {
      Logger.error(`Error activating booking ${booking.id}:`, error);
      throw error;
    }
  }

  /**
   * Handle expired booking (past scheduled time without being started)
   */
  async expireBooking(booking) {
    try {
      // booking.service comes from the caller's findMany include -- see the
      // note there (audit #53/#133) for why this is no longer a fresh
      // per-booking lookup.
      const service = booking.service;

      // Update booking status to cancelled or expired
      await prisma.booking.update({
        where: { id: booking.id },
        data: {
          status: 'cancelled',
          notes: (booking.notes || '') + ' [Auto-cancelled: Scheduled time passed without service start]',
          updatedAt: new Date()
        }
      });

        // Create notification for user
        await createNotification({
          userId: booking.userId,
          ...renderNotification(NOTIFICATION_TYPES.BOOKING_EXPIRED, {
            serviceName: service?.name,
            bookingId: booking.id,
          }),
        });

        // Create notification for vendor
        if (service) {
          await createNotification({
            userId: service.vendorId,
            ...renderNotification(NOTIFICATION_TYPES.BOOKING_MISSED_EXPIRED, {
              serviceName: service.name,
              bookingId: booking.id,
            }),
          });
        }      Logger.info(`Expired booking ${booking.id} - moved to cancelled status`);

    } catch (error) {
      Logger.error(`Error expiring booking ${booking.id}:`, error);
      throw error;
    }
  }

  /**
   * Lower bound for the activation/expiry queries: today minus one day, IST,
   * at UTC midnight -- matching how `booking_date` itself is stored (see the
   * comment in parseBookingDateTime). One day of slack rather than zero
   * covers a booking dated "yesterday" IST whose late-night slot is still
   * within EXPIRY_AFTER_MINUTES of `now` when read back as UTC.
   */
  getActivationLowerBound(now) {
    const ist = getISTDate(now);
    const year = ist.getFullYear();
    const month = ist.getMonth();
    const day = ist.getDate();
    return new Date(Date.UTC(year, month, day - 1, 0, 0, 0, 0));
  }

  /**
   * Parse booking date and time into a Date object
   */
  parseBookingDateTime(dateInput, timeString) {
    try {
      if (!dateInput) return null;

      // Handle different input types
      let date;

      if (dateInput instanceof Date) {
        // Already a Date object
        date = new Date(dateInput);
      } else if (typeof dateInput === 'string') {
        // Handle string formats
        if (dateInput.includes && dateInput.includes('T')) {
          // ISO format
          date = new Date(dateInput);
        } else {
          // Date string format (YYYY-MM-DD)
          date = new Date(dateInput);
        }
      } else {
        // Unknown format, try to convert
        date = new Date(dateInput);
      }

      // Validate the date
      if (isNaN(date.getTime())) {
        Logger.error('Invalid date created from input:', dateInput);
        return null;
      }

      // The calendar day. `booking_date` is stored as UTC midnight of the
      // intended day (a bare "YYYY-MM-DD" is always parsed as UTC per the
      // date-only ISO rule), so reading it back via getUTC*() gives the right
      // day regardless of what timezone THIS process happens to be running
      // in -- unlike the `.setHours()` this replaces.
      const year = date.getUTCFullYear();
      const month = date.getUTCMonth();
      const day = date.getUTCDate();

      // Delegate to the same parser createBooking normalises through
      // (controllers/user/bookingController.js), rather than the split+parseInt
      // this replaces. That hand-rolled version had no AM/PM handling, so a
      // legacy "3:00 PM" row parsed as 03:00 -- the activation cron then fired
      // at 3am and left a 3pm booking sitting in in_progress all day, showing
      // under Ongoing from dawn onwards. booking_time is only canonical 24h for
      // rows created since that normalisation landed; older ones are still the
      // free text the comment at bookingController.js:351 describes.
      // No time at all is a legitimate "whole day" row -> midnight IST, which
      // is the long-standing behaviour. Only a time that IS present and cannot
      // be understood is treated as bad data below.
      // An ABSENT time (null/undefined) is a legitimate "whole day" row and
      // means midnight IST -- long-standing behaviour, kept.
      //
      // An empty or whitespace-only string is not that: it is bad data. It used
      // to fall into the midnight branch, which would let the cron activate the
      // booking at 00:00 and march it through to expiry, while a whitespace
      // string ("  ") already returned null via the parser. Same garbage input,
      // two different outcomes. Both are now treated as unparseable.
      const isAbsent = timeString === null || timeString === undefined;
      const isBlankString = typeof timeString === 'string' && timeString.trim() === '';
      const totalMinutes = isAbsent
        ? 0
        : isBlankString
          ? null
          : parseTimeToMinutes(timeString);
      if (totalMinutes === null) {
        // Unparseable: return null so the caller's existing "Invalid date/time"
        // warning fires. Defaulting to midnight would silently activate the
        // booking at the wrong time, which is how this bug stayed hidden.
        return null;
      }
      const hours = Math.floor(totalMinutes / 60);
      const minutes = totalMinutes % 60;

      // Every customer is booking against IST wall-clock time (this is an
      // India-only service -- see getISTDate() in util/time.js for the same
      // assumption elsewhere), but this used `date.setHours(hours, minutes)`,
      // which sets the hour in whatever timezone the NODE PROCESS happens to
      // be running in. Locally that is often IST already, so the bug is
      // invisible in dev -- but nothing in this repo pins TZ=Asia/Kolkata for
      // the deployed container (checked Dockerfile, deploy.yml,
      // docker-compose.yml), and Cloud Run's default is UTC. On a UTC
      // container, "8:30" was being set as 8:30 UTC = 2:00 PM IST -- hours
      // away from the customer's actual 8:30 AM IST booking -- which is
      // exactly the kind of drift that makes the ±5-minute activation window
      // below fire at the wrong real-world moment, sometimes activating a
      // booking well before or after the time the customer actually picked.
      //
      // Fixed by computing the UTC instant directly from the INTENDED IST
      // wall-clock time (UTC = IST − 5:30), so the result is identical no
      // matter what timezone this process is deployed into.
      const IST_OFFSET_MS = (5 * 60 + 30) * 60 * 1000;
      return new Date(Date.UTC(year, month, day, hours, minutes, 0, 0) - IST_OFFSET_MS);
    } catch (error) {
      Logger.error('Error parsing booking date/time:', error, 'Input:', dateInput, 'Time:', timeString);
      return null;
    }
  }

  /**
   * Stop the booking status monitoring service
   */
  stop() {
    if (this.isRunning) {
      cron.getTasks().forEach(task => task.destroy());
      this.isRunning = false;
      Logger.info('Booking Status Manager stopped');
    }
  }
}

// Export singleton instance
const bookingStatusManager = new BookingStatusManager();
export default bookingStatusManager;