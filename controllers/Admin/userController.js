import prisma from "../../util/prisma.js";

export const getUserMetrics = async (req, res) => {
  try {

    const [
      totalUsers,
      activeUsers,
      inactiveUsers,
      uninstalledUsers
    ] = await Promise.all([

      // total users
      prisma.user.count(),

      // active users
      prisma.user.count({
        where: {
          is_active: true,
          bookings: {
            some: {}
          }
        }
      }),

      // inactive users
      prisma.user.count({
        where: {
          bookings: {
            none: {}
          }
        }
      }),

      // uninstalled users
      prisma.user.count({
        where: {
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

    let filter = {};

    
    if (type === "active") {
      filter = {
        is_active: true,
        bookings: {
          some: {}
        }
      };
    }

    else if (type === "inactive") {
      filter = {
        bookings: {
          none: {}
        }
      };
    }

    else if (type === "uninstalled") {
      filter = {
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

        userProfile: {
          select: {
            name: true,
            phone: true
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
      contact: user.userProfile?.phone || "N/A",
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

    await prisma.user.delete({
      where: {
        id: Number(id)
      }
    });

    res.json({
      message: "User deleted successfully"
    });

  } catch (error) {
    console.error(error);
    res.status(500).json({
      message: "Failed to delete user"
    });
  }
};