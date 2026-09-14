import prisma from "../../util/prisma.js";
import { eraseUserPii } from "../../services/accountErasureService.js";

export const getUserMetrics = async (req, res) => {
  try {

    const [
      totalUsers,
      activeUsers,
      inactiveUsers,
      uninstalledUsers
    ] = await Promise.all([

      // total users
      prisma.user.count({
        where: { role: "user" }
      }),

      // active users
      prisma.user.count({
        where: {
          role: "user",
          is_active: true,
          bookings: {
            some: {}
          }
        }
      }),

      // inactive users
      prisma.user.count({
        where: {
          role: "user",
          bookings: {
            none: {}
          }
        }
      }),

      // uninstalled users
      prisma.user.count({
        where: {
          role: "user",
          fcmToken: null,
          pushToken: null
        }
      })

    ]);

    res.json({
      totalUsers,
      activeUsers,
      inactiveUsers,
      uninstalledUsers
    });

  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Failed to fetch user metrics" });
  }
};

export const getUsers = async (req, res) => {
  try {

    const { type = "all", page = 1, limit = 10 } = req.query;

    const skip = (page - 1) * limit;

    let filter = { role: "user" };

    if (type === "active") {
      filter = {
        role: "user",
        is_active: true,
        bookings: {
          some: {}
        }
      };
    }

    else if (type === "inactive") {
      filter = {
        role: "user",
        bookings: {
          none: {}
        }
      };
    }

    else if (type === "uninstalled") {
      filter = {
        role: "user",
        fcmToken: null,
        pushToken: null
      };
    }

    
    const users = await prisma.user.findMany({
      where: filter,

      select: {
        id: true,
        is_active: true,
        createdAt: true,
        email: true,

        userProfile: {
          select: {
            name: true,
            phone: true,
            profile_picture: true
          }
        },

        _count: {
          select: {
            bookings: true
          }
        }
      },

      orderBy: {
        createdAt: "desc"
      },

      skip: Number(skip),
      take: Number(limit)
    });


    const formatted = users.map(user => ({
      id: user.id,
      name: user.userProfile?.name || "N/A",
      email: user.email || "",
      contact: user.userProfile?.phone || "N/A",
      profileImage: user.userProfile?.profile_picture || null,
      bookings: user._count.bookings,
      status: user.is_active ? "active" : "inactive",
      joined: user.createdAt
    }));

    res.json(formatted);

  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Failed to fetch users" });
  }
};

export const deleteUser = async (req, res) => {
  try {
    const { id } = req.params;
    const userId = Number(id);

    const bookingCount = await prisma.booking.count({ where: { userId } });

    if (bookingCount === 0) {
      // No booking/payment history — safe to hard-delete.
      await prisma.user.delete({ where: { id: userId } });
      return res.json({ message: "User deleted successfully" });
    }

    // Has booking history: Booking.user is now onDelete: Restrict, so a
    // hard delete would fail (correctly) rather than silently wiping the
    // payment/payout audit trail. `is_active: false` alone used to be the
    // entire "delete" here -- UserProfile (name, phone, address,
    // id_proof_*), the User's own fcmToken/pushToken, PhoneIdentity,
    // claimed WalkInJob customer fields, and any uploaded Cloudinary
    // documents all stayed exactly as they were, with no erasure path
    // reachable from this admin action at all (2026-09-12 audit, F11).
    // eraseUserPii deactivates AND redacts those fields.
    const result = await eraseUserPii(userId);

    res.json({
      message: "User deactivated and personal data erased (has existing booking history, so the account record itself was retained rather than deleted)",
      erasure: result,
    });

  } catch (error) {
    console.error(error);
    if (error.statusCode === 404) {
      return res.status(404).json({ message: "User not found" });
    }
    res.status(500).json({
      message: "Failed to delete user"
    });
  }
};