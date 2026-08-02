import prisma from "../../util/prisma.js";



// @desc    Get Vendor Inventory
// @route   GET /service_api/vendor/:vendorId/inventory
export const getInventory = async (req, res) => {
    const vendorId = parseInt(req.params.vendorId);
    if (req.user.id !== vendorId) {
        return res.status(403).json({ message: 'Not authorized' });
    }
    try {
        const inventory = await prisma.inventory.findMany({
            where: { vendorId }
        });
        res.json(inventory);
    } catch (error) {
        console.error(error);
        res.status(500).json({ message: 'Server Error' });
    }
}

// @desc    Add Inventory Item
// @route   POST /service_api/vendor/:vendorId/inventory/create
export const createInventory = async (req, res) => {
    const vendorId = parseInt(req.params.vendorId);
    if (req.user.id !== vendorId) {
        return res.status(403).json({ message: 'Not authorized' });
    }
    const { item_name, stock_level } = req.body;
    try {
        const item = await prisma.inventory.create({
            data: {
                vendorId,
                item_name,
                stock_level: parseInt(stock_level)
            }
        });
        res.status(201).json(item);
    } catch (error) {
        console.error(error);
        res.status(500).json({ message: 'Server Error' });
    }
}

// @desc    Update Inventory Item
// @route   PUT /service_api/vendor/:vendorId/inventory/update/:inventoryId
export const updateInventory = async (req, res) => {
    const vendorId = parseInt(req.params.vendorId);
    const inventoryId = parseInt(req.params.inventoryId);
    const { item_name, stock_level } = req.body;
    try {
        // Verify the item actually belongs to the requesting vendor before writing —
        // the URL's vendorId alone can't be trusted (an attacker could match it to
        // themselves while inventoryId points at someone else's item).
        const existing = await prisma.inventory.findUnique({ where: { id: inventoryId } });
        if (!existing || existing.vendorId !== vendorId || req.user.id !== vendorId) {
            return res.status(403).json({ message: 'Not authorized' });
        }

        const item = await prisma.inventory.update({
            where: { id: inventoryId },
            data: {
                item_name,
                stock_level: parseInt(stock_level)
            }
        });
        res.json(item);
    } catch (error) {
        console.error(error);
        res.status(500).json({ message: 'Server Error' });
    }
}




