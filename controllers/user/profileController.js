import prisma from "../../util/prisma.js";
import Logger from "../../util/logger.js";
import { eraseUserPii } from "../../services/accountErasureService.js";
import { getUserDataExport } from "../../services/accountExportService.js";



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
    let { name, phone, address, profile_picture, id_proof_front, id_proof_back } = req.body;

    // Verify user owns this profile
    if (req.user.id !== userId) {
      return res.status(403).json({ message: "Not authorized" });
    }
    
    // uploadMiddleware uses multer.memoryStorage(), so req.file has a `buffer`
    // and NO `.path` — the Cloudinary result lives at req.file.cloudinary.
    // Reading `.path` stored undefined (null), so uploaded profile pictures
    // were silently discarded on every save.
    if (req.file) {
      profile_picture = req.file?.cloudinary?.secure_url;
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

// @desc    Erase the caller's own account (GDPR Art.17). Deactivates and
//          redacts personal data; see services/accountErasureService.js for
//          exactly what is and is not touched.
// @route   DELETE /service_api/user/:userId/account
export const deleteUserAccount = async (req, res) => {
  try {
    const userId = parseInt(req.params.userId);

    // Verify the caller owns this account -- there is no admin bypass on
    // this route, unlike controllers/Admin/userController.js's deleteUser.
    if (req.user.id !== userId) {
      return res.status(403).json({ message: "Not authorized" });
    }

    const result = await eraseUserPii(userId);

    Logger.info(`[Profile] Self-service account erasure for user ${userId}`);
    res.json({
      message: "Account deactivated and personal data erased.",
      erasure: result,
    });
  } catch (error) {
    if (error.statusCode === 404) {
      return res.status(404).json({ message: "User not found" });
    }
    Logger.error(`[Profile] Account erasure error: ${error.message}`);
    res.status(500).json({ message: "Server Error" });
  }
};

// @desc    Export the caller's own data (GDPR Art.15/Art.20 access and
//          portability). No admin bypass, no DSAR ticket needed -- this is
//          the backing implementation the privacy policy's third-party DSAR
//          form previously had nothing behind (2026-09-12 audit, F48).
// @route   GET /service_api/user/:userId/export
export const exportUserData = async (req, res) => {
  try {
    const userId = parseInt(req.params.userId);

    if (req.user.id !== userId) {
      return res.status(403).json({ message: "Not authorized" });
    }

    const bundle = await getUserDataExport(userId);
    if (!bundle) {
      return res.status(404).json({ message: "User not found" });
    }

    Logger.info(`[Profile] Data export requested by user ${userId}`);
    res.json(bundle);
  } catch (error) {
    Logger.error(`[Profile] Export error: ${error.message}`);
    res.status(500).json({ message: "Server Error" });
  }
};
