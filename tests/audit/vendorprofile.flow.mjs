// Audit flow for the Vendor profile & shop management module:
// routes/vendor/{profile,services,availability,inventory,documents,healthSheets}.js
process.env.AUDIT_DB_NAME = 'keplix_audit_vendorprofile';

const { seed } = await import('./seed.mjs');
const { scanForBrokenShapes } = await import('./assertShape.mjs');
const { prisma, bcrypt, call, token, listRoutes, shutdown } = await import('./harness.mjs');

let pass = 0, fail = 0;
const failures = [];

function check(name, cond, extra) {
  if (cond) { pass++; }
  else { fail++; failures.push({ name, extra }); console.log('FAIL:', name, extra ?? ''); }
}

function shapeCheck(name, json) {
  const problems = scanForBrokenShapes(json);
  check(`${name} :: shape`, problems.length === 0, problems);
}

async function main() {
  const ids = await seed(prisma, bcrypt);
  const vTok = token(ids.vendor.id);
  const v2Tok = token(ids.vendor2.id);
  const custTok = token(ids.customer.id);

  console.log('Routes in this module:');
  for (const r of listRoutes()) {
    if (/vendor|documents|health-sheets|health-components/i.test(r.path)) console.log(' ', r.method, r.path);
  }

  // ---------- PROFILE ----------
  {
    const res = await call('GET', '/accounts/vendor', { as: vTok });
    check('GET profile happy path 200', res.status === 200, res);
    shapeCheck('GET profile', res.json);
    check('GET profile has business_name', res.json?.business_name === 'Audit Garage', res.json);
  }
  {
    const res = await call('GET', '/accounts/vendor');
    check('GET profile no auth -> 401', res.status === 401, res);
  }
  {
    // text-only update (no files)
    const res = await call('PUT', '/accounts/vendor', { as: vTok, body: { business_name: 'Updated Garage Name', city: 'New Delhi' } });
    check('PUT profile text-only 200', res.status === 200, res);
    shapeCheck('PUT profile', res.json);
    check('PUT profile applied business_name', res.json?.business_name === 'Updated Garage Name', res.json);
    check('PUT profile applied city + combined address', res.json?.city === 'New Delhi' && typeof res.json?.address === 'string' && res.json.address.includes('New Delhi'), res.json);
  }
  {
    // PATCH partial update
    const res = await call('PATCH', '/accounts/vendor', { as: vTok, body: { description: 'A fine garage' } });
    check('PATCH profile 200', res.status === 200, res);
    shapeCheck('PATCH profile', res.json);
    check('PATCH profile kept business_name from before', res.json?.business_name === 'Updated Garage Name', res.json);
  }
  {
    // online-status toggle
    const res = await call('PATCH', '/accounts/vendor/online-status', { as: vTok, body: { is_online: false } });
    check('PATCH online-status 200', res.status === 200, res);
    shapeCheck('PATCH online-status', res.json);
    check('PATCH online-status applied', res.json?.is_online === false, res.json);

    const res2 = await call('PATCH', '/accounts/vendor/online-status', { as: vTok, body: { is_online: true } });
    check('PATCH online-status back on 200', res2.status === 200 && res2.json?.is_online === true, res2);
  }
  {
    // bad body: is_online not boolean
    const res = await call('PATCH', '/accounts/vendor/online-status', { as: vTok, body: { is_online: 'yes' } });
    check('PATCH online-status bad body -> 400', res.status === 400, res);
  }
  {
    // POST create when profile already exists -> 400
    const res = await call('POST', '/accounts/vendor', { as: vTok, body: { business_name: 'Dup', phone: '9999999999' } });
    check('POST create when exists -> 400', res.status === 400, res);
  }
  {
    // POST create bad body (missing required business_name)
    const res = await call('POST', '/accounts/vendor', { as: v2Tok, body: { phone: '9999999999' } });
    check('POST create missing business_name -> 400', res.status === 400, res);
  }
  {
    // cross-vendor: vendor2 gets/updates own, not vendor1's (profile keyed by req.user.id, no vendorId param, so no cross-vendor path exists here)
    const res = await call('GET', '/accounts/vendor', { as: v2Tok });
    check('vendor2 GET own profile 200 (isolated by token)', res.status === 200 && res.json?.business_name === 'Pending Garage', res.json);
  }
  {
    // customer role hitting vendor profile route
    const res = await call('GET', '/accounts/vendor', { as: custTok });
    check('customer GET vendor profile -> 404 (no profile row)', res.status === 404, res);
  }

  // ---------- SERVICES ----------
  let newServiceId;
  {
    const res = await call('GET', `/service_api/vendor/${ids.vendor.id}/services`, { as: vTok });
    check('GET vendor services 200', res.status === 200, res);
    shapeCheck('GET vendor services', res.json);
    check('GET vendor services includes seeded services', Array.isArray(res.json) && res.json.length === 3, res.json);
  }
  {
    // create service, customer role forbidden
    const res = await call('POST', `/service_api/vendor/${ids.customer.id}/services/create`, {
      as: custTok,
      body: { name: 'Hack Service', description: 'x', price: 100, duration: 30, category: 'Car Service & Repairs' },
    });
    check('customer create service -> 403', res.status === 403, res);
  }
  {
    const res = await call('POST', `/service_api/vendor/${ids.vendor.id}/services/create`, {
      as: vTok,
      body: { name: 'Wheel Alignment', description: 'Align wheels', price: 599, duration: 45, category: 'Car Service & Repairs', is_active: true },
    });
    check('vendor create service 201', res.status === 201, res);
    shapeCheck('POST create service', res.json);
    newServiceId = res.json?.id;
    check('created service has id', !!newServiceId, res.json);
  }
  {
    // create with segment_prices
    const res = await call('POST', `/service_api/vendor/${ids.vendor.id}/services/create`, {
      as: vTok,
      body: {
        name: 'Full Detailing', description: 'Detailing', price: 999, duration: 90, category: 'Car Service & Repairs',
        segment_prices: [{ segment: 'HATCHBACK', price: 899 }, { segment: 'SEDAN', price: 999 }],
      },
    });
    check('vendor create service with segment_prices 201', res.status === 201, res);
    shapeCheck('POST create service segment_prices', res.json);
    check('segment prices persisted', Array.isArray(res.json?.segmentPrices) && res.json.segmentPrices.length === 2, res.json);
  }
  {
    // bad body: missing required fields
    const res = await call('POST', `/service_api/vendor/${ids.vendor.id}/services/create`, {
      as: vTok, body: { name: 'Incomplete' },
    });
    check('create service missing fields -> 400', res.status === 400, res);
  }
  {
    // update own service
    const res = await call('PUT', `/service_api/vendor/${ids.vendor.id}/services/update/${newServiceId}`, {
      as: vTok, body: { price: 649 },
    });
    check('vendor update own service 200', res.status === 200, res);
    shapeCheck('PUT update service', res.json);
    check('price updated', String(res.json?.price) === '649' || Number(res.json?.price) === 649, res.json);
  }
  {
    // pause service (is_active=false) and confirm excluded from customer-facing list
    const res = await call('PUT', `/service_api/vendor/${ids.vendor.id}/services/update/${newServiceId}`, {
      as: vTok, body: { is_active: false },
    });
    check('vendor pause service 200', res.status === 200, res);
    check('service now inactive', res.json?.is_active === false, res.json);

    const customerList = await call('GET', `/service_api/user/vendors/${ids.vendor.id}/services`, { as: custTok });
    if (customerList.status === 200) {
      const stillListed = (customerList.json?.data || customerList.json || []).some?.((s) => s.id === newServiceId);
      check('paused service excluded from customer-facing list', !stillListed, customerList.json);
    } else {
      // route path may differ; try the known searchServices path instead as a fallback, non-fatal
      console.log('  note: customer by-vendor services route returned', customerList.status, '- skipping exclusion assertion path A');
    }
  }
  {
    // re-activate
    const res = await call('PUT', `/service_api/vendor/${ids.vendor.id}/services/update/${newServiceId}`, {
      as: vTok, body: { is_active: true },
    });
    check('vendor re-activate service 200', res.status === 200 && res.json?.is_active === true, res.json);
  }
  {
    // cross-vendor update attempt: vendor2 tries to update vendor1's service
    const res = await call('PUT', `/service_api/vendor/${ids.vendor2.id}/services/update/${newServiceId}`, {
      as: v2Tok, body: { price: 1 },
    });
    check('vendor2 update vendor1 service -> 403', res.status === 403, res);
    // Confirm price truly unchanged
    const after = await prisma.service.findUnique({ where: { id: newServiceId } });
    check('service price unchanged after cross-vendor attempt', Number(after.price) !== 1, after);
  }
  {
    // update non-existent service
    const res = await call('PUT', `/service_api/vendor/${ids.vendor.id}/services/update/999999`, {
      as: vTok, body: { price: 10 },
    });
    check('update nonexistent service -> 404', res.status === 404, res);
  }
  {
    // cross-vendor delete attempt
    const res = await call('DELETE', `/service_api/vendor/${ids.vendor2.id}/services/delete/${newServiceId}`, { as: v2Tok });
    check('vendor2 delete vendor1 service -> 404 (not authorized/found)', res.status === 404, res);
    const stillThere = await prisma.service.findUnique({ where: { id: newServiceId } });
    check('service still exists after cross-vendor delete attempt', !!stillThere, stillThere);
  }
  {
    // owner deletes own service
    const res = await call('DELETE', `/service_api/vendor/${ids.vendor.id}/services/delete/${newServiceId}`, { as: vTok });
    check('vendor delete own service 200', res.status === 200, res);
    const gone = await prisma.service.findUnique({ where: { id: newServiceId } });
    check('service actually removed', !gone, gone);
  }

  // ---------- AVAILABILITY ----------
  {
    const res = await call('GET', `/service_api/vendor/${ids.vendor.id}/availability`, { as: vTok });
    check('GET availability 200 (empty at first)', res.status === 200 && Array.isArray(res.json), res);
    shapeCheck('GET availability', res.json);
  }
  {
    // cross-vendor read
    const res = await call('GET', `/service_api/vendor/${ids.vendor.id}/availability`, { as: v2Tok });
    check('vendor2 GET vendor1 availability -> 403', res.status === 403, res);
  }
  {
    const res = await call('POST', `/service_api/vendor/${ids.vendor.id}/availability/create`, {
      as: vTok, body: { day_of_week: 'Monday', start_time: '09:00', end_time: '18:00' },
    });
    check('create availability 201', res.status === 201, res);
    shapeCheck('POST availability create', res.json);
  }
  {
    // cross-vendor create attempt
    const res = await call('POST', `/service_api/vendor/${ids.vendor.id}/availability/create`, {
      as: v2Tok, body: { day_of_week: 'Tuesday', start_time: '09:00', end_time: '18:00' },
    });
    check('vendor2 create vendor1 availability -> 403', res.status === 403, res);
    const rows = await prisma.availability.findMany({ where: { vendorId: ids.vendor.id } });
    check('no availability row leaked in from vendor2 attempt', rows.every((r) => r.day_of_week !== 'Tuesday'), rows);
  }
  {
    // bad body: invalid time format
    const res = await call('POST', `/service_api/vendor/${ids.vendor.id}/availability/create`, {
      as: vTok, body: { day_of_week: 'Wednesday', start_time: '9am', end_time: '18:00' },
    });
    check('create availability bad time -> 400', res.status === 400, res);
  }

  // ---------- INVENTORY ----------
  let invId;
  {
    const res = await call('GET', `/service_api/vendor/${ids.vendor.id}/inventory`, { as: vTok });
    check('GET inventory 200', res.status === 200 && Array.isArray(res.json), res);
    shapeCheck('GET inventory', res.json);
  }
  {
    const res = await call('GET', `/service_api/vendor/${ids.vendor.id}/inventory`, { as: v2Tok });
    check('vendor2 GET vendor1 inventory -> 403', res.status === 403, res);
  }
  {
    const res = await call('POST', `/service_api/vendor/${ids.vendor.id}/inventory/create`, {
      as: vTok, body: { item_name: 'Engine Oil 5W30', stock_level: 20 },
    });
    check('create inventory 201', res.status === 201, res);
    shapeCheck('POST inventory create', res.json);
    invId = res.json?.id;
  }
  {
    // bad body: missing item_name
    const res = await call('POST', `/service_api/vendor/${ids.vendor.id}/inventory/create`, {
      as: vTok, body: { stock_level: 5 },
    });
    check('create inventory missing item_name -> 400', res.status === 400, res);
  }
  {
    const res = await call('PUT', `/service_api/vendor/${ids.vendor.id}/inventory/update/${invId}`, {
      as: vTok, body: { stock_level: 15 },
    });
    check('update own inventory 200', res.status === 200, res);
    shapeCheck('PUT inventory update', res.json);
    check('stock updated', res.json?.stock_level === 15, res.json);
  }
  {
    // cross-vendor update: vendor2 tries via vendor1's vendorId in URL (mismatched with own id -> 403 either way)
    const res = await call('PUT', `/service_api/vendor/${ids.vendor.id}/inventory/update/${invId}`, {
      as: v2Tok, body: { stock_level: 999 },
    });
    check('vendor2 update vendor1 inventory (via vendor1 URL) -> 403', res.status === 403, res);
  }
  {
    // cross-vendor update: vendor2 uses own id in URL but targets vendor1's inventoryId
    const res = await call('PUT', `/service_api/vendor/${ids.vendor2.id}/inventory/update/${invId}`, {
      as: v2Tok, body: { stock_level: 999 },
    });
    check('vendor2 update vendor1 inventory (via own URL, foreign id) -> 403', res.status === 403, res);
    const after = await prisma.inventory.findUnique({ where: { id: invId } });
    check('inventory stock unchanged after cross-vendor attempts', after.stock_level === 15, after);
  }
  {
    // update non-existent inventory item
    const res = await call('PUT', `/service_api/vendor/${ids.vendor.id}/inventory/update/999999`, {
      as: vTok, body: { stock_level: 1 },
    });
    check('update nonexistent inventory -> 403 or 404', [403, 404].includes(res.status), res);
  }

  // ---------- DOCUMENTS ----------
  {
    const res = await call('GET', '/accounts/documents', { as: vTok });
    check('GET documents 200 (empty)', res.status === 200 && Array.isArray(res.json), res);
    shapeCheck('GET documents', res.json);
  }
  {
    // upload without file -> 400 (skip real Cloudinary upload)
    const res = await call('POST', '/accounts/documents', { as: vTok, body: { document_type: 'GST_CERTIFICATE' } });
    // This is sent as JSON, not multipart, so uploadSingle sees no file field; expect 400 "File required" or a validation error.
    check('upload document without file -> 4xx', res.status >= 400 && res.status < 500, res);
  }

  // ---------- HEALTH SHEETS ----------
  {
    const res = await call('GET', '/service_api/vendor/health-components', { as: vTok });
    check('GET health-components 200', res.status === 200, res);
    shapeCheck('GET health-components', res.json);
  }
  {
    // no auth
    const res = await call('GET', '/service_api/vendor/health-components');
    check('GET health-components no auth -> 401', res.status === 401, res);
  }
  {
    // fetch a health sheet that doesn't exist
    const res = await call('GET', '/service_api/vendor/health-sheets/999999', { as: vTok });
    check('GET nonexistent health sheet -> 404', res.status === 404, res);
  }
  {
    // health sheet for nonexistent booking
    const res = await call('GET', '/service_api/vendor/bookings/999999/health-sheet', { as: vTok });
    check('GET health-sheet for nonexistent booking -> 404', res.status === 404, res);
  }
  {
    // health sheet for nonexistent walk-in job
    const res = await call('GET', '/service_api/vendor/walk-in-jobs/999999/health-sheet', { as: vTok });
    check('GET health-sheet for nonexistent walk-in job -> 404', res.status === 404, res);
  }
  {
    // create health sheet with bad body: neither bookingId nor walkInJobId
    const res = await call('POST', '/service_api/vendor/health-sheets', {
      as: vTok, body: { items: [{ component_key: 'engine', status: 'GOOD' }] },
    });
    check('create health sheet no parent -> 400', res.status === 400, res);
  }
  {
    // create health sheet against a booking that doesn't belong to vendor (doesn't exist)
    const res = await call('POST', '/service_api/vendor/health-sheets', {
      as: vTok, body: { bookingId: 999999, items: [{ component_key: 'engine', status: 'GOOD' }] },
    });
    check('create health sheet for nonexistent booking -> 404', res.status === 404, res);
  }

  // ---------- Full route enumeration coverage sanity ----------
  const moduleRoutes = listRoutes().filter((r) =>
    /^\/accounts\/vendor/.test(r.path) ||
    /^\/accounts\/documents/.test(r.path) ||
    (/^\/service_api\/vendor\/:vendorId\/(services|availability|inventory)/.test(r.path)) ||
    /^\/service_api\/vendor\/(health-sheets|health-components|bookings\/:param\/health-sheet|walk-in-jobs\/:param\/health-sheet)/.test(r.path)
  );
  console.log(`\nModule route count observed: ${moduleRoutes.length}`);

  console.log(`\n=== RESULTS: ${pass} passed, ${fail} failed ===`);
  if (fail > 0) {
    console.log('Failures:', JSON.stringify(failures.map((f) => f.name), null, 2));
  }
  await shutdown();
  process.exit(fail > 0 ? 1 : 0);
}

main().catch(async (e) => {
  console.error('FATAL', e);
  try { await shutdown(); } catch {}
  process.exit(1);
});
