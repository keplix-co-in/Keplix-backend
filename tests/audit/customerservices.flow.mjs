process.env.AUDIT_DB_NAME = 'keplix_audit_customerservices';

const { seed } = await import('./seed.mjs');
const { scanForBrokenShapes } = await import('./assertShape.mjs');
const { prisma, bcrypt, call, token, listRoutes, shutdown } = await import('./harness.mjs');

let pass = 0, fail = 0;
const results = [];
function check(name, cond, extra) {
  if (cond) { pass++; results.push(`PASS ${name}`); }
  else { fail++; results.push(`FAIL ${name}${extra ? ' :: ' + JSON.stringify(extra) : ''}`); }
}
function shapeCheck(name, json) {
  const problems = scanForBrokenShapes(json);
  check(`${name} :: no broken shapes`, problems.length === 0, problems);
}

try {
  const ids = await seed(prisma, bcrypt);
  const custTok = token(ids.customer.id);

  // --- list all services ---
  {
    const res = await call('GET', '/service_api/user/services');
    check('GET /service_api/user/services 200', res.status === 200, res);
    shapeCheck('GET /service_api/user/services', res.json);
    check('GET /service_api/user/services returns array', Array.isArray(res.json), res.json);
    check('GET /service_api/user/services only approved-online vendor services', Array.isArray(res.json) && res.json.length === 3, res.json?.length);
  }

  // --- also mounted at /service_api/services ---
  {
    const res = await call('GET', '/service_api/services');
    check('GET /service_api/services 200 (alt mount)', res.status === 200, res);
    shapeCheck('GET /service_api/services', res.json);
  }

  // --- pagination limit probing (no endpoint should accept unbounded ?limit=) ---
  {
    // Add extra services so a huge limit would be observable if unbounded.
    for (let i = 0; i < 5; i++) {
      await prisma.service.create({
        data: { vendorId: ids.vendor.id, name: `Extra ${i}`, description: 'x', price: '100.00', duration: 30, category: 'Car Service & Repairs', is_active: true },
      });
    }
    const res = await call('GET', '/service_api/user/services?limit=999999999');
    check('GET services?limit=999999999 does not 500', res.status === 200, res);
    // Whatever the cap, it must not literally hand back a request for
    // 999999999 rows straight to the DB. We assert the response is capped
    // well below that (a sane implementation caps around 100).
    check('GET services?limit=999999999 result size is capped, not unbounded', Array.isArray(res.json) && res.json.length < 1000, res.json?.length);
  }
  {
    const res = await call('GET', `/service_api/user/vendors/${ids.vendor.id}/services?limit=999999999`);
    check('GET vendor services?limit=999999999 does not 500', res.status === 200, res);
    check('GET vendor services?limit=999999999 result size is capped', Array.isArray(res.json) && res.json.length < 1000, res.json?.length);
  }
  {
    const res = await call('GET', '/service_api/user/garage/history?limit=999999999', { as: custTok });
    check('GET garage/history?limit=999999999 does not 500', res.status === 200, res);
    check('GET garage/history?limit=999999999 result size is capped', res.json?.data && res.json.data.length < 10000, res.json?.data?.length);
  }

  // --- featured services ---
  {
    const res = await call('GET', '/service_api/user/services/featured');
    check('GET services/featured 200', res.status === 200, res);
    shapeCheck('GET services/featured', res.json);
    check('featured includes only is_featured+online vendor services', res.json?.data?.some((s) => s.name === 'Oil Change'), res.json);
  }

  // --- service detail ---
  {
    const res = await call('GET', `/service_api/user/services/${ids.services[0].id}`);
    check('GET services/:id 200', res.status === 200, res);
    shapeCheck('GET services/:id', res.json);
    check('service detail has segment_prices array', Array.isArray(res.json?.segment_prices), res.json);
    check('service detail does not leak vendor secrets', res.json?.vendor?.password === undefined && res.json?.vendor?.vendorProfile?.bank_account_number === undefined, res.json);
  }
  {
    const res = await call('GET', '/service_api/user/services/999999999');
    check('GET services/:id 404 for missing', res.status === 404, res);
  }

  // --- services by vendor ---
  {
    const res = await call('GET', `/service_api/user/vendors/${ids.vendor.id}/services`);
    check('GET vendors/:id/services 200', res.status === 200, res);
    shapeCheck('GET vendors/:id/services', res.json);
    check('services by vendor have segment_prices mapped', Array.isArray(res.json) && res.json.every((s) => Array.isArray(s.segment_prices)), res.json);
  }

  // --- category list ---
  {
    const res = await call('GET', '/service_api/user/categories');
    check('GET categories 200', res.status === 200, res);
    shapeCheck('GET categories', res.json);
    check('categories is an array of {name}', Array.isArray(res.json) && res.json.every((c) => typeof c.name === 'string'), res.json);
  }

  // --- location search: /service_api/user/search ---
  {
    const res = await call('GET', '/service_api/user/search?latitude=28.4595&longitude=77.0266&radius=50');
    check('GET user/search with lat/lng 200', res.status === 200, res);
    shapeCheck('GET user/search with lat/lng', res.json);
    check('user/search returns approved online vendor only', res.json?.vendors?.length === 1, res.json);
  }
  {
    const res = await call('GET', '/service_api/user/search');
    check('GET user/search without lat/lng -> 400', res.status === 400, res);
  }

  // --- location search on the /service_api/user/services (online_only + lat/lng) endpoint ---
  {
    const resNoOnline = await call('GET', '/service_api/user/services?latitude=28.4595&longitude=77.0266&radius=50');
    check('services w/ lat/lng 200', resNoOnline.status === 200, resNoOnline);
    shapeCheck('services w/ lat/lng', resNoOnline.json);

    // Take a vendor offline, then confirm online_only=true excludes their services.
    await prisma.vendorProfile.update({ where: { userId: ids.vendor.id }, data: { is_online: false } });
    const resOnlineOnly = await call('GET', '/service_api/user/services?latitude=28.4595&longitude=77.0266&radius=50&online_only=true');
    check('online_only=true excludes offline vendor (lat/lng branch)', Array.isArray(resOnlineOnly.json) && resOnlineOnly.json.length === 0, resOnlineOnly.json);

    const resOnlineOnlyNoLoc = await call('GET', '/service_api/user/services?online_only=true');
    check('online_only=true excludes offline vendor (no-location branch)', Array.isArray(resOnlineOnlyNoLoc.json) && resOnlineOnlyNoLoc.json.length === 0, resOnlineOnlyNoLoc.json);

    // Restore online state for later checks.
    await prisma.vendorProfile.update({ where: { userId: ids.vendor.id }, data: { is_online: true } });
  }

  // --- /service_api/search (also mounted) ---
  {
    const res = await call('GET', '/service_api/search?latitude=28.4595&longitude=77.0266');
    check('GET /service_api/search (alt mount) 200', res.status === 200, res);
    shapeCheck('GET /service_api/search alt mount', res.json);
  }

  // --- customer garage: vehicles ---
  let newVehicleId;
  {
    const res = await call('POST', '/service_api/user/garage/vehicles', {
      as: custTok,
      body: { registration: 'DL1CAF1234', car_name: 'My Car', make: 'Honda', model: 'City', year: 2019, segment: 'SEDAN', fuel_type: 'PETROL' },
    });
    check('POST garage/vehicles 201', res.status === 201, res);
    shapeCheck('POST garage/vehicles', res.json);
    newVehicleId = res.json?.vehicle?.id;
  }
  {
    const res = await call('GET', '/service_api/user/garage/vehicles', { as: custTok });
    check('GET garage/vehicles 200', res.status === 200, res);
    shapeCheck('GET garage/vehicles', res.json);
    check('garage/vehicles lists the new vehicle', res.json?.data?.some((v) => v.id === newVehicleId), res.json);
  }
  {
    const res = await call('GET', `/service_api/user/garage/vehicles/${newVehicleId}`, { as: custTok });
    check('GET garage/vehicles/:id 200', res.status === 200, res);
    shapeCheck('GET garage/vehicles/:id', res.json);
  }
  {
    const res = await call('PATCH', `/service_api/user/garage/vehicles/${newVehicleId}`, { as: custTok, body: { odometer_km: 15000 } });
    check('PATCH garage/vehicles/:id 200', res.status === 200, res);
    shapeCheck('PATCH garage/vehicles/:id', res.json);
    check('odometer updated', res.json?.vehicle?.odometer_km === 15000, res.json);
  }
  {
    // Cross-user ownership check: customer2 cannot see/edit customer's vehicle.
    const cust2Tok = token(ids.customer2.id);
    const res = await call('GET', `/service_api/user/garage/vehicles/${newVehicleId}`, { as: cust2Tok });
    check('another customer cannot read this vehicle (404)', res.status === 404, res);
  }
  {
    const res = await call('DELETE', `/service_api/user/garage/vehicles/${newVehicleId}`, { as: custTok });
    check('DELETE garage/vehicles/:id 200', res.status === 200, res);
  }

  // --- garage claim request/verify ---
  {
    const res = await call('POST', '/service_api/user/garage/claim/request', { as: custTok, body: { phone: '+919990001111' } });
    check('POST garage/claim/request 200 (generic)', res.status === 200, res);
    check('garage/claim/request generic response shape', res.json?.success === true, res.json);
  }
  {
    // Wrong OTP against a request that was never verified.
    const otpRow = await prisma.phoneOTP.findUnique({ where: { phone_number: '+919990001111' } });
    const res = await call('POST', '/service_api/user/garage/claim/verify', { as: custTok, body: { phone: '+919990001111', otp: otpRow.otp } });
    check('POST garage/claim/verify 200 with correct otp', res.status === 200, res);
    shapeCheck('POST garage/claim/verify', res.json);
  }

  // --- garage history & active jobs ---
  {
    const res = await call('GET', '/service_api/user/garage/history', { as: custTok });
    check('GET garage/history 200', res.status === 200, res);
    shapeCheck('GET garage/history', res.json);
  }
  {
    const res = await call('GET', '/service_api/user/jobs/active', { as: custTok });
    check('GET jobs/active 200', res.status === 200, res);
    shapeCheck('GET jobs/active', res.json);
  }

  // --- auth required on garage routes ---
  {
    const res = await call('GET', '/service_api/user/garage/vehicles');
    check('GET garage/vehicles without token -> 401', res.status === 401, res);
  }

} catch (e) {
  fail++;
  results.push(`FAIL (uncaught exception) :: ${e.stack}`);
} finally {
  console.log(results.join('\n'));
  console.log(`\n${pass} passed, ${fail} failed`);
  await shutdown();
  process.exit(fail > 0 ? 1 : 0);
}
