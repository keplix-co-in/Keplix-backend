import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

// @desc    Get bookings for logged in user
// @route   GET /service_api/user/bookings/
export const getUserBookings = async (req, res) => {
    try {
        const bookings = await prisma.booking.findMany({
            where: { userId: req.user.id },
            include: {
                service: {
                    include: { vendor: { include: { vendorProfile: true } } }
                }
            },
            orderBy: { booking_date: 'desc' }
        });

        const formattedBookings = bookings.map(booking => ({
            ...booking,
            service: {
                ...booking.service,
                image_url: booking.service.image_url ? `${req.protocol}://${req.get('host')}${booking.service.image_url}` : null,
                image: booking.service.image_url ? `${req.protocol}://${req.get('host')}${booking.service.image_url}` : null,
                vendor_name: booking.service.vendor?.vendorProfile?.business_name || 'Vendor',
            }
        }));

        res.json(formattedBookings);
    } catch (error) {
        console.error(error);
        res.status(500).json({ message: 'Server Error' });
    }
};

// @desc    Create a new booking
// @route   POST /service_api/bookings/
export const createBooking = async (req, res) => {
    const { serviceId, booking_date, booking_time, notes } = req.body;

    try {
        const booking = await prisma.booking.create({
            data: {
                userId: req.user.id,
                serviceId: serviceId, // Already validated as number by Zod
                booking_date: new Date(booking_date),
                booking_time,
                notes
            }
        });

        res.status(201).json(booking);
    } catch (error) {
        console.error(error);
        res.status(500).json({ message: 'Server Error' });
    }
}

// @desc    Update/Cancel booking
// @route   PUT /service_api/user/:userId/bookings/update/:id
export const updateBooking = async (req, res) => {
    const { status, booking_date, booking_time, notes } = req.body;
    const bookingId = parseInt(req.params.id);

    try {
        const booking = await prisma.booking.findUnique({
            where: { id: bookingId }
        });

        if (!booking) {
            return res.status(404).json({ message: "Booking not found" });
        }

        // Ensure user owns the booking
        if (booking.userId !== req.user.id) {
            return res.status(403).json({ message: "Not authorized to update this booking" });
        }

        // Only allow cancellation if status is pending or confirmed (not completed)
        if (status === 'cancelled') {
             if (booking.status === 'completed' || booking.status === 'cancelled') {
                 return res.status(400).json({ message: `Cannot cancel booking that is already ${booking.status}` });
             }
        }

        const updatedBooking = await prisma.booking.update({
            where: { id: bookingId },
            data: {
                status: status || undefined,
                booking_date: booking_date ? new Date(booking_date) : undefined,
                booking_time: booking_time || undefined,
                notes: notes || undefined
            }
        });

        res.json(updatedBooking);

    } catch (error) {
        console.error(error);
        res.status(500).json({ message: 'Server Error' });
    }
};
