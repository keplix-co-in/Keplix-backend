import prisma from 'file:///C:/keplix-frontend-master/keplix-backend/util/prisma.js';



// @desc    Get Vendor Inventory
// @route   GET /service_api/vendor/:vendorId/inventory
export const getInventory = async (req, res) => {
    try {
        const inventory = await prisma.inventory.findMany({
            where: { vendorId: parseInt(req.params.vendorId) }
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
    const { item_name, stock_level } = req.body;
    try {
        const item = await prisma.inventory.create({
            data: {
                vendorId: parseInt(req.params.vendorId),
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
    const { item_name, stock_level } = req.body;
    try {
        const item = await prisma.inventory.update({
            where: { id: parseInt(req.params.inventoryId) },
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




