// Standard seed data for audit flow tests, so every module starts from the
// same known state. Import prisma/bcrypt from harness.mjs (already configured
// for the module's own scratch database) and pass them in here.
export async function seed(prisma, bcrypt) {
  const pw = await bcrypt.hash('Passw0rd!x', 4);
  const mkUser = (email, role) => prisma.user.create({ data: { email, password: pw, role, is_active: true, is_verified: true } });

  const customer = await mkUser('customer@audit.test', 'user');
  const customer2 = await mkUser('customer2@audit.test', 'user');
  const vendor = await mkUser('vendor@audit.test', 'vendor');
  const vendor2 = await mkUser('vendor2@audit.test', 'vendor');

  await prisma.userProfile.create({ data: { userId: customer.id, name: 'Audit Customer', phone: '9000000001' } });
  await prisma.userProfile.create({ data: { userId: customer2.id, name: 'Audit Customer Two', phone: '9000000004' } });

  const vp = (u, over) =>
    prisma.vendorProfile.create({
      data: {
        userId: u.id,
        business_name: 'Audit Garage',
        phone: '9000000002',
        status: 'approved',
        onboarding_completed: true,
        is_online: true,
        latitude: 28.4595,
        longitude: 77.0266,
        city: 'Gurugram',
        address: '1 Test Rd',
        operating_hours: '09:00 - 18:00',
        ...over,
      },
    });
  await vp(vendor, {});
  // A second vendor left pending/unapproved on purpose — several audit checks
  // (admin approval, search visibility) depend on there being one of these.
  await vp(vendor2, { business_name: 'Pending Garage', status: 'pending', onboarding_completed: false, phone: '9000000003' });

  const svc = (name, price, extra = {}) =>
    prisma.service.create({
      data: { vendorId: vendor.id, name, description: name + ' desc', price, duration: 60, category: 'Car Service & Repairs', is_active: true, ...extra },
    });
  const s1 = await svc('Oil Change', '799.00', { is_featured: true });
  const s2 = await svc('Brake Pads', '1499.50');
  const s3 = await svc('AC Service', '2499');

  let vehicle = null;
  try {
    vehicle = await prisma.vehicle.create({
      data: { ownerUserId: customer.id, registration: 'HR26AB1234', make: 'Maruti', model: 'Swift', year: 2020, segment: 'HATCHBACK', fuel_type: 'PETROL' },
    });
  } catch (e) {
    console.log('vehicle create note:', e.message.split('\n').slice(-2).join(' '));
  }

  const admin = await prisma.admin.create({
    data: { name: 'Root Admin', email: 'root@audit.test', password: await bcrypt.hash('AdminPass1!', 4), role: 'admin', status: 'ACTIVE' },
  });

  return { customer, customer2, vendor, vendor2, admin, services: [s1, s2, s3], vehicle };
}

export default seed;
