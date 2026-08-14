import prisma from '../../util/prisma.js';

// @desc    List all inspection components (including inactive, unlike the
//          vendor-facing listHealthComponents which only shows active ones)
// @route   GET /admin/health-components
export const listHealthComponentsAdmin = async (req, res) => {
  try {
    const data = await prisma.healthComponent.findMany({ orderBy: { display_order: 'asc' } });
    return res.json({ data });
  } catch (error) {
    return res.status(500).json({ message: 'Server Error' });
  }
};

// @desc    Add a new inspection component (e.g. wipers, coolant) — the whole
//          point of a template table over a hardcoded list is that this is
//          an admin action, not a deploy.
// @route   POST /admin/health-components
export const createHealthComponent = async (req, res) => {
  const { key, label, display_order } = req.body;
  try {
    const component = await prisma.healthComponent.create({
      data: { key, label, display_order: display_order ?? 0 },
    });
    return res.status(201).json({ component });
  } catch (error) {
    if (error.code === 'P2002') {
      return res.status(409).json({ message: 'A component with this key already exists.' });
    }
    return res.status(500).json({ message: 'Server Error' });
  }
};

// @desc    Edit label/order, or activate/deactivate a component.
// @route   PATCH /admin/health-components/:id
export const updateHealthComponent = async (req, res) => {
  const { label, display_order, is_active } = req.body;
  try {
    const component = await prisma.healthComponent.update({
      where: { id: parseInt(req.params.id) },
      data: {
        ...(label !== undefined ? { label } : {}),
        ...(display_order !== undefined ? { display_order } : {}),
        ...(is_active !== undefined ? { is_active } : {}),
      },
    });
    return res.json({ component });
  } catch (error) {
    if (error.code === 'P2025') return res.status(404).json({ message: 'Component not found' });
    return res.status(500).json({ message: 'Server Error' });
  }
};
