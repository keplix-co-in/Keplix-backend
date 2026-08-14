import prisma from '../../util/prisma.js';
import { getPlatformSettings } from '../../util/platformSettings.js';

// @desc    Current platform settings, including the health-sheet
//          enforcement gate. Uses the same getPlatformSettings() the
//          completion-gate check itself uses, so admin always sees the
//          value that's actually in effect — including the documented
//          "no row exists yet" default rather than a 404 or a crash.
// @route   GET /admin/platform-settings
export const getPlatformSettingsAdmin = async (req, res) => {
  try {
    const settings = await getPlatformSettings();
    return res.json({ settings });
  } catch (error) {
    return res.status(500).json({ message: 'Server Error' });
  }
};

// @desc    Update platform settings, including the health-sheet enforcement
//          gate. See prisma/schema.prisma's PlatformSettings comment and the
//          rollout notes in services/healthSheetService.js before flipping
//          isHealthSheetRequired — enabling it without a future
//          healthSheetRequiredFrom immediately gates every existing
//          in-progress booking's completion, which sits on the escrow-release
//          path.
// @route   PATCH /admin/platform-settings
export const updatePlatformSettingsAdmin = async (req, res) => {
  const { isPlatformFeeEnabled, platformFeePercentage, isHealthSheetRequired, healthSheetRequiredFrom } = req.body;

  try {
    const existing = await prisma.platformSettings.findFirst();
    const data = {
      ...(isPlatformFeeEnabled !== undefined ? { isPlatformFeeEnabled } : {}),
      ...(platformFeePercentage !== undefined ? { platformFeePercentage } : {}),
      ...(isHealthSheetRequired !== undefined ? { isHealthSheetRequired } : {}),
      ...(healthSheetRequiredFrom !== undefined
        ? { healthSheetRequiredFrom: healthSheetRequiredFrom ? new Date(healthSheetRequiredFrom) : null }
        : {}),
      updatedAt: new Date(),
    };

    const settings = existing
      ? await prisma.platformSettings.update({ where: { id: existing.id }, data })
      : await prisma.platformSettings.create({ data });

    return res.json({ settings });
  } catch (error) {
    return res.status(500).json({ message: 'Server Error' });
  }
};
