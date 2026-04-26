import cron from 'node-cron';
import prisma from './prisma.js';
import Logger from './logger.js';
import { createNotification } from './notificationHelper.js';

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

          // Check if the booking time has arrived (within a 5-minute window)
          const timeDiff = now.getTime() - bookingDateTime.getTime();
          const minutesDiff = timeDiff / (1000 * 60);

          // Activate if time has arrived (within 5 minutes before or after)
          if (minutesDiff >= -5 && minutesDiff <= 5) {
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

          // Check if booking is more than 30 minutes past scheduled time
          const timeDiff = now.getTime() - bookingDateTime.getTime();
          const minutesDiff = timeDiff / (1000 * 60);

          if (minutesDiff > 30) {
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
      // Find bookings pending vendor approval
      const pendingBookings = await prisma.booking.findMany({
        where: {
          vendor_status: 'pending',
          status: 'pending'
        }
      });

      let declinedCount = 0;

      for (const booking of pendingBookings) {
        try {
          const createdAt = new Date(booking.createdAt);
          const timeDiff = now.getTime() - createdAt.getTime();
          const minutesDiff = timeDiff / (1000 * 60);

          // If booking has been pending for more than 5 minutes
          if (minutesDiff >= 5) {
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
                notes: (booking.notes || '') + '\n[Auto-declined: Vendor did not accept within 5 minutes]'
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
            Logger.info(`Auto-declined booking ${booking.id} after 5 minutes of inactivity`);
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

      if (timeString && typeof timeString === 'string') {
        // Parse time (HH:MM or HH:MM:SS)
        const timeParts = timeString.split(':');
        const hours = parseInt(timeParts[0]) || 0;
        const minutes = parseInt(timeParts[1]) || 0;

        date.setHours(hours, minutes, 0, 0);
      } else {
        // Default to start of day if no time
        date.setHours(0, 0, 0, 0);
      }

      return date;
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