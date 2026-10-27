import cron from 'node-cron';
import prisma from './prisma.js';
import Logger from './logger.js';
import { createNotification } from './notificationHelper.js';
import { renderNotification, NOTIFICATION_TYPES } from './notificationTemplates.js';
import { parseTimeToMinutes } from './slots.js';
import { getISTDate } from './time.js';
import { RESERVED_STATUSES } from '../services/refundService.js';
import { confirmBookingAndQueuePayout } from '../services/bookingConfirmationService.js';

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
 * How long a customer has, after the workshop marks a job service_completed,
 * to confirm or dispute it before it is confirmed on their behalf and the
 * workshop's payout released (autoConfirmCompletedBookings below).
 *
 * Without this a customer who simply never opened the app again held the
 * workshop's money in escrow forever: confirmBookingAndQueuePayout was only
 * ever reached from the customer's own Confirm button. 48 hours is the owner's
 * chosen window; BOOKING_AUTO_CONFIRM_HOURS overrides it. Read here rather than
 * through config/env.js, the same way PENDING_TIMEOUT_MINUTES is. A value that
 * is not a positive number falls back to 48 rather than to "release
 * immediately".
 */
const AUTO_CONFIRM_HOURS = (() => {
  const configured = Number(process.env.BOOKING_AUTO_CONFIRM_HOURS);
  return Number.isFinite(configured) && configured > 0 ? configured : 48;
})();

// Upper bound per tick, so a backlog (first deploy, or the cron having been
// down) is worked through over several ticks instead of one long burst of
// payout transactions.
const AUTO_CONFIRM_BATCH_SIZE = 50;

// vendorPayoutStatus values meaning the payout is already claimed. Must match
// the list confirmBookingAndQueuePayout refuses
// (services/bookingConfirmationService.js); see autoConfirmCompletedBookings.
const CLAIMED_PAYOUT_STATUSES = ['paid', 'settled', 'processing'];

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

    // Auto-confirm runs on its own, slower schedule: its window is measured in
    // hours, so a once-a-minute check would only add load, and keeping it out
    // of processBookingStatusUpdates means a slow payout transaction can never
    // delay the minute-sensitive activation/expiry jobs. Same in-process
    // dispatcher as above -- the backend is deliberately single-instance (see
    // CLAUDE.md), so there is no second copy of this job to race.
    cron.schedule('*/10 * * * *', async () => {
      try {
        await this.autoConfirmCompletedBookings(new Date());
      } catch (error) {
        Logger.error('Error in auto-confirm cron job:', error);
      }
    });

    // And once on startup, as the minute job does above. Cloud Run scales this
    // service to zero (--min-instances 0 in deploy.yml), and a cold start
    // serving one short request may never live long enough to reach a
    // */10 tick, so without this the window could be overrun indefinitely.
    // autoConfirmCompletedBookings catches its own query errors; the .catch is
    // for anything else.
    this.autoConfirmCompletedBookings(new Date()).catch(error => {
      Logger.error('Error in initial auto-confirm run:', error);
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
            if (await this.activateBooking(booking)) {
              activatedCount++;
            }
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
   * Handle bookings whose slot passed more than EXPIRY_AFTER_MINUTES ago
   * without the activation job having started them.
   *
   * These are now STARTED LATE, not cancelled (2026-10-24, replacing the
   * 2026-10-20 "cancel and fully refund a paid no-show" rule). Why: nothing
   * but this cron ever starts a normal booking -- the partner app has no Start
   * button for one (only walk-ins and early start), and an accepted booking is
   * confirmed at accept time, paid or not. activateBookingsAtScheduledTime
   * starts every such booking the minute its slot arrives, so a booking only
   * reaches this branch when no tick ran for 30+ minutes: the backend deploys
   * with --min-instances 0 (deploy.yml) and the in-process cron does not run
   * while Cloud Run has scaled it to zero. "Expired" meant "our server was
   * asleep", not "the workshop did not show". Cancelling (and refunding) it
   * killed a real job for our downtime -- the vendor could no longer complete
   * a cancelled booking, and the customer lost a slot they still wanted.
   * Starting it late gives exactly the outcome an on-time tick would have.
   * A genuine no-show is NOT covered by any self-serve path yet: the customer
   * cannot cancel an in_progress booking (USER_CANCELLABLE_STATUSES) or
   * dispute one before service_completed (serviceConfirmationController), so
   * today it needs an admin refund via the finance refund endpoint, and the
   * booking stays in_progress. That gap predates this change (an on-time
   * activation leads to the same place); see PROJECT_LOG backlog.
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

      let lateStartCount = 0;

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
          // activateBooking's write is guarded, so a booking the customer
          // cancelled (or the vendor started) since the findMany is left alone.
          if (minutesDiff > EXPIRY_AFTER_MINUTES) {
            if (await this.activateBooking(booking)) {
              lateStartCount++;
              // There is no admin notification channel; a tagged log line is
              // how ops finds these (same convention as paymentService.js).
              Logger.warn(
                `[ADMIN NOTICE] Booking ${booking.id} started ${Math.round(minutesDiff)} min after its slot -- the booking cron did not run in time (likely a scale-to-zero gap). Check the job actually happened.`
              );
            }
          }
        } catch (error) {
          Logger.error(`Error processing expired booking ${booking.id}:`, error);
        }
      }

      if (lateStartCount > 0) {
        Logger.info(`Started ${lateStartCount} bookings late that passed their scheduled time`);
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

      // updateMany with the findMany's preconditions repeated in the WHERE,
      // not update({ where: { id } }) -- same reasoning as the pending-timeout
      // job above. The read happened at the top of this tick; in the gap the
      // customer may have cancelled, or the vendor already started or even
      // completed the job. An unconditional write flipped a cancelled booking
      // back to in_progress, or rolled a service_completed one backwards.
      // count === 0 means someone else moved it first: no write, no
      // "service started" notifications.
      const activated = await prisma.booking.updateMany({
        where: {
          id: booking.id,
          status: { in: ['confirmed', 'scheduled'] },
          vendor_status: 'accepted',
        },
        data: {
          status: 'in_progress',
          updatedAt: new Date()
        }
      });

      if (activated.count === 0) {
        Logger.info(`Booking ${booking.id} changed status before it could be activated; leaving it alone.`);
        return false;
      }

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
      return true;

    } catch (error) {
      Logger.error(`Error activating booking ${booking.id}:`, error);
      throw error;
    }
  }

  /**
   * Confirm bookings the customer left in service_completed past the
   * auto-confirm window (AUTO_CONFIRM_HOURS), releasing the workshop's payout.
   *
   * Goes through confirmBookingAndQueuePayout -- the same function as the
   * customer's own Confirm button -- with no rating, so every guard on that
   * path applies unchanged: payment row lock, payment must be 'success',
   * payout not already claimed, no refund in flight, and (since the guarded
   * write in that function) a dispute that commits concurrently wins and the
   * whole confirmation rolls back.
   */
  async autoConfirmCompletedBookings(now) {
    const cutoff = new Date(now.getTime() - AUTO_CONFIRM_HOURS * 60 * 60 * 1000);

    let candidates;
    try {
      candidates = await prisma.booking.findMany({
        where: {
          status: 'service_completed',
          // Rows that reached service_completed before service_completed_at
          // existed have it NULL. They are skipped deliberately (lt already
          // excludes NULL in SQL; `not: null` just says so): with no
          // timestamp there is no way to know when the customer's window
          // started, and guessing (e.g. from updatedAt, which any later write
          // bumps) could release a payout the customer is still entitled to
          // object to. Those few legacy rows stay on the manual path.
          service_completed_at: { not: null, lt: cutoff },
          // Only bookings the confirmation can actually succeed on: a
          // successful payment with no refund in flight. Anything else would
          // fail inside confirmBookingAndQueuePayout on every tick forever.
          //
          // The payout must also still be unclaimed. confirmBookingAndQueuePayout
          // refuses a payment whose vendorPayoutStatus is paid/settled/processing
          // (an admin settled it by hand, or a payout is already queued).
          // Without this filter those rows matched on every tick, sorted first
          // by service_completed_at, failed inside the confirmation, and could
          // fill the whole batch of AUTO_CONFIRM_BATCH_SIZE, so no other
          // booking was ever auto-confirmed. NULL is listed explicitly because
          // SQL `NOT IN` never matches NULL.
          payment: {
            is: {
              status: 'success',
              refunds: { none: { status: { in: RESERVED_STATUSES } } },
              OR: [
                { vendorPayoutStatus: null },
                { vendorPayoutStatus: { notIn: CLAIMED_PAYOUT_STATUSES } },
              ],
            },
          },
        },
        include: { service: { select: { name: true } } },
        orderBy: { service_completed_at: 'asc' },
        take: AUTO_CONFIRM_BATCH_SIZE,
      });
    } catch (error) {
      Logger.error('Error finding bookings to auto-confirm:', error);
      return 0;
    }

    let confirmedCount = 0;

    for (const booking of candidates) {
      try {
        await confirmBookingAndQueuePayout({
          userId: booking.userId,
          bookingId: booking.id,
        });
      } catch (error) {
        // Per booking, so one failure does not stop the batch. The usual
        // cause is benign: the customer disputed (or confirmed) between the
        // findMany and the confirmation -- that is the dispute winning, as
        // intended. Anything persistent shows up here every tick.
        Logger.warn(`Auto-confirm skipped booking ${booking.id}: ${error.message}`);
        continue;
      }

      confirmedCount++;
      Logger.info(`Auto-confirmed booking ${booking.id} after ${AUTO_CONFIRM_HOURS}h in service_completed`);

      await createNotification({
        userId: booking.userId,
        ...renderNotification(NOTIFICATION_TYPES.SERVICE_AUTO_CONFIRMED, {
          serviceName: booking.service?.name,
          bookingId: booking.id,
        }),
      });
    }

    if (confirmedCount > 0) {
      Logger.info(`Auto-confirmed ${confirmedCount} completed bookings`);
    }
    return confirmedCount;
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