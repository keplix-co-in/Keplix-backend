import prisma from "../../util/prisma.js";
import Logger from "../../util/logger.js";



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
    const { name, phone, address, profile_picture, id_proof_front, id_proof_back } = req.body;

    // Verify user owns this profile
    if (req.user.id !== userId) {
      return res.status(403).json({ message: "Not authorized" });
    }

    // Build update data - only include fields that are provided
    const updateData = {};
    if (name !== undefined) updateData.name = name;
    if (phone !== undefined) updateData.phone = phone;
    if (address !== undefined) updateData.address = address;
    if (profile_picture !== undefined) updateData.profile_picture = profile_picture;
    if (id_proof_front !== undefined) updateData.id_proof_front = id_proof_front;
    if (id_proof_back !== undefined) updateData.id_proof_back = id_proof_back;

    // Upsert user profile
    const profile = await prisma.userProfile.upsert({
      where: { userId: userId },
      update: updateData,
      create: {
        userId: userId,
        name: name || "User",
        phone: phone || null,
        address: address || null,
        profile_picture: profile_picture || null,
        id_proof_front: id_proof_front || null,
        id_proof_back: id_proof_back || null,
      },
    });

    Logger.info(`[Profile] Updated for user ${userId}`);
    res.json(profile);
  } catch (error) {
    Logger.error(`[Profile] Update error: ${error.message}`);
    res.status(500).json({ message: "Server Error" });
  }
};



