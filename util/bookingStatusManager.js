import cron from 'node-cron';
import prisma from './prisma.js';
import Logger from './logger.js';
import { createNotification } from './notificationHelper.js';
import { parseTimeToMinutes } from './slots.js';

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
  process.env.BOOKING_PENDING_TIMEOUT_MINUTES || 5
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
      // Find bookings that are confirmed/scheduled and their time has arrived
      const bookingsToActivate = await prisma.booking.findMany({
        where: {
          status: {
            in: ['confirmed', 'scheduled']
          },
          vendor_status: 'accepted',
        }
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
      // Find confirmed/scheduled bookings that are past their time
      const expiredBookings = await prisma.booking.findMany({
        where: {
          status: {
            in: ['confirmed', 'scheduled']
          },
          vendor_status: 'accepted',
        }
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
        }
      });

      let declinedCount = 0;

      for (const booking of pendingBookings) {
        try {
          {
            // The query above already restricted this to rows past the
            // deadline, so there is no per-row time check left to do.
            // Fetch service to get name
            const service = await prisma.service.findUnique({
              where: { id: booking.serviceId }
            });

            await prisma.booking.update({
              where: { id: booking.id },
              data: {
                vendor_status: 'rejected',
                status: 'cancelled',
                updatedAt: new Date(),
                notes: (booking.notes || '') + `\n[Auto-declined: Vendor did not accept within ${PENDING_TIMEOUT_MINUTES} minutes]`
              }
            });

            // Notify user
            await createNotification({
              userId: booking.userId,
              title: 'Booking Request Declined',
              message: `Your booking request for ${service?.name || 'service'} was not accepted in time and has been automatically declined.`,
              type: 'booking_update',
              data: { bookingId: booking.id }
            });

            // Notify vendor - fetch vendor id from service
            if (service) {
              await createNotification({
                userId: service.vendorId,
                title: 'Booking Request Expired',
                message: `You missed a booking request for ${service.name}. It has been automatically declined.`,
                type: 'booking_update',
                data: { bookingId: booking.id }
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
      // Fetch service to get details for notifications
      const service = await prisma.service.findUnique({
        where: { id: booking.serviceId }
      });

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
        title: 'Service Started',
        message: `Your ${service?.name || 'service'} service has started.`,
        type: 'booking_update',
        data: { bookingId: booking.id }
      });

      // Create notification for vendor
      if (service) {
        await createNotification({
          userId: service.vendorId,
          title: 'Service Time Arrived',
          message: `It's time to start the ${service.name} service.`,
          type: 'booking_update',
          data: { bookingId: booking.id }
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
      // Fetch service to get details for notifications
      const service = await prisma.service.findUnique({
        where: { id: booking.serviceId }
      });

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
        await createNotification(
          booking.userId,
          'Booking Expired',
          `Your ${service?.name || 'service'} booking has expired as the scheduled time passed.`,
          { type: 'booking_update', bookingId: booking.id }
        );

        // Create notification for vendor
        if (service) {
          await createNotification(
            service.vendorId,
            'Booking Expired',
            `The ${service.name} booking has expired due to missed scheduled time.`,
            { type: 'booking_update', bookingId: booking.id }
          );
        }      Logger.info(`Expired booking ${booking.id} - moved to cancelled status`);

    } catch (error) {
      Logger.error(`Error expiring booking ${booking.id}:`, error);
      throw error;
    }
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
      const totalMinutes =
        timeString === null || timeString === undefined || timeString === ''
          ? 0
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