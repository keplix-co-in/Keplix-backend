import { PrismaClient } from "@prisma/client";
import Logger from "../../util/logger.js";

const prisma = new PrismaClient();

// @desc    Get user profile
// @route   GET /service_api/user/:userId/profile
export const getUserProfileData = async (req, res) => {
  try {
    const userId = parseInt(req.params.userId);

    // Verify user owns this profile
    if (req.user.id !== userId) {
      return res.status(403).json({ message: "Not authorized" });
    }

    const user = await prisma.user.findUnique({
      where: { id: userId },
      include: {
        userProfile: true,
      },
      select: {
        id: true,
        email: true,
        role: true,
        is_active: true,
        createdAt: true,
        fcmToken: true,
        userProfile: true,
      },
    });

    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }

    res.json(user);
  } catch (error) {
    Logger.error(`[Profile] Get error: ${error.message}`);
    res.status(500).json({ message: "Server Error" });
  }
};

// @desc    Update user profile
// @route   PUT /service_api/user/:userId/profile
export const updateUserProfile = async (req, res) => {
  try {
    const userId = parseInt(req.params.userId);
    const { name, phone, address } = req.body;

    // Verify user owns this profile
    if (req.user.id !== userId) {
      return res.status(403).json({ message: "Not authorized" });
    }

    // Upsert user profile
    const profile = await prisma.userProfile.upsert({
      where: { userId: userId },
      update: {
        name: name || undefined,
        phone: phone || undefined,
        address: address || undefined,
      },
      create: {
        userId: userId,
        name: name,
        phone: phone || null,
        address: address || null,
      },
    });

    Logger.info(`[Profile] Updated for user ${userId}`);
    res.json(profile);
  } catch (error) {
    Logger.error(`[Profile] Update error: ${error.message}`);
    res.status(500).json({ message: "Server Error" });
  }
};
