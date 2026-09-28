process.env.AUDIT_DB_NAME = 'keplix_audit_auth';

const { seed } = await import('./seed.mjs');
const { scanForBrokenShapes } = await import('./assertShape.mjs');
const { prisma, bcrypt, call, token, adminToken, listRoutes, shutdown } = await import('./harness.mjs');

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

  console.log('--- routes registered (auth-related) ---');
  for (const r of listRoutes().filter((r) => r.path.includes('/accounts/auth') || r.path.includes('/logout'))) {
    console.log(r.method, r.path);
  }

  // ===================== REGISTER / SIGNUP =====================
  {
    const res = await call('POST', '/accounts/auth/register', { body: { email: 'newuser@audit.test', password: 'Passw0rd!x' } });
    check('register happy path -> 201', res.status === 201, res.status + ' ' + res.text);
    shapeCheck('register happy', res.json);
  }
  {
    // duplicate email
    const res = await call('POST', '/accounts/auth/register', { body: { email: 'customer@audit.test', password: 'Passw0rd!x' } });
    check('register duplicate email -> 400', res.status === 400, res.status + ' ' + res.text);
  }
  {
    // bad body (missing password)
    const res = await call('POST', '/accounts/auth/register', { body: { email: 'bad@audit.test' } });
    check('register missing password -> 400', res.status === 400, res.status + ' ' + res.text);
  }
  {
    // signup alias
    const res = await call('POST', '/accounts/auth/signup', { body: { email: 'newuser2@audit.test', password: 'Passw0rd!x' } });
    check('signup alias -> 201', res.status === 201, res.status + ' ' + res.text);
  }

  // ===================== LOGIN =====================
  let accessToken, refreshTok;
  {
    const res = await call('POST', '/accounts/auth/login', { body: { email: 'customer@audit.test', password: 'Passw0rd!x' } });
    check('login happy path -> 200', res.status === 200, res.status + ' ' + res.text);
    shapeCheck('login happy', res.json);
    if (res.json?.access) { accessToken = res.json.access; refreshTok = res.json.refresh; }
    check('login returns access+refresh', !!accessToken && !!refreshTok);
  }
  {
    const res = await call('POST', '/accounts/auth/login', { body: { email: 'customer@audit.test', password: 'WrongPassword!' } });
    check('login wrong password -> 401', res.status === 401, res.status + ' ' + res.text);
  }
  {
    const res = await call('POST', '/accounts/auth/login', { body: { email: 'doesnotexist@audit.test', password: 'Passw0rd!x' } });
    check('login unknown email -> 401', res.status === 401, res.status + ' ' + res.text);
  }
  {
    // bad body missing email
    const res = await call('POST', '/accounts/auth/login', { body: { password: 'Passw0rd!x' } });
    check('login missing email -> 400', res.status === 400, res.status + ' ' + res.text);
  }
  {
    // vendor login shape
    const res = await call('POST', '/accounts/auth/login', { body: { email: 'vendor@audit.test', password: 'Passw0rd!x' } });
    check('vendor login -> 200', res.status === 200, res.status + ' ' + res.text);
    shapeCheck('vendor login', res.json);
    check('vendor login has onboarding_completed field', res.json?.user?.onboarding_completed !== undefined);
  }

  // ===================== PROFILE (protected) =====================
  {
    const res = await call('GET', '/accounts/auth/profile', { as: accessToken });
    check('profile GET happy -> 200', res.status === 200, res.status + ' ' + res.text);
    shapeCheck('profile GET happy', res.json);
  }
  {
    const res = await call('GET', '/accounts/auth/profile');
    check('profile GET unauthenticated -> 401', res.status === 401, res.status + ' ' + res.text);
  }
  {
    const res = await call('GET', '/accounts/auth/profile', { as: 'garbage.token.value' });
    check('profile GET bad token -> 401', res.status === 401, res.status + ' ' + res.text);
  }
  {
    const res = await call('PUT', '/accounts/auth/profile', { as: accessToken, body: { name: 'Updated Name' } });
    check('profile PUT happy -> 200', res.status === 200, res.status + ' ' + res.text);
    shapeCheck('profile PUT happy', res.json);
  }

  // ===================== REFRESH (rotation + reuse) =====================
  let refresh2;
  {
    const res = await call('POST', '/accounts/auth/token/refresh', { body: { refresh: refreshTok } });
    check('refresh happy path -> 200', res.status === 200, res.status + ' ' + res.text);
    shapeCheck('refresh happy', res.json);
    refresh2 = res.json?.refresh;
  }
  {
    // reused (now-blacklisted) refresh token
    const res = await call('POST', '/accounts/auth/token/refresh', { body: { refresh: refreshTok } });
    check('reused refresh token -> 401', res.status === 401, res.status + ' ' + res.text);
  }
  {
    const res = await call('POST', '/accounts/auth/token/refresh', { body: {} });
    check('refresh missing body -> 400', res.status === 400, res.status + ' ' + res.text);
  }
  {
    const res = await call('POST', '/accounts/auth/token/refresh', { body: { refresh: 'not-a-jwt' } });
    check('refresh malformed token -> 401', res.status === 401, res.status + ' ' + res.text);
  }
  {
    // expired refresh token (manually crafted)
    const jwt = (await import('jsonwebtoken')).default;
    const expired = jwt.sign({ id: ids.customer.id, type: 'refresh' }, process.env.JWT_REFRESH_SECRET, { expiresIn: -10 });
    const res = await call('POST', '/accounts/auth/token/refresh', { body: { refresh: expired } });
    check('expired refresh token -> 401', res.status === 401, res.status + ' ' + res.text);
  }

  // ===================== LOGOUT (blacklist) =====================
  let logoutAccess, logoutRefresh;
  {
    const loginRes = await call('POST', '/accounts/auth/login', { body: { email: 'customer2@audit.test', password: 'Passw0rd!x' } });
    logoutAccess = loginRes.json?.access;
    logoutRefresh = loginRes.json?.refresh;
  }
  {
    const res = await call('POST', '/accounts/auth/logout', { headers: { Authorization: `Bearer ${logoutAccess}` }, body: { refresh: logoutRefresh } });
    check('logout happy path -> 200', res.status === 200, res.status + ' ' + res.text);
  }
  {
    // blacklisted access token should now fail on a protected route
    const res = await call('GET', '/accounts/auth/profile', { as: logoutAccess });
    check('blacklisted access token rejected -> 401', res.status === 401, res.status + ' ' + res.text);
  }
  {
    // blacklisted refresh token should be rejected by refresh endpoint too
    const res = await call('POST', '/accounts/auth/token/refresh', { body: { refresh: logoutRefresh } });
    check('blacklisted refresh token rejected -> 401', res.status === 401, res.status + ' ' + res.text);
  }
  {
    // logout with no token
    const res = await call('POST', '/accounts/auth/logout', {});
    check('logout no token -> 400', res.status === 400, res.status + ' ' + res.text);
  }

  // ===================== FORGOT PASSWORD (retired -> 410) =====================
  {
    const res = await call('POST', '/accounts/auth/forgot-password', { body: { email: 'customer@audit.test' } });
    check('forgot-password retired -> 410', res.status === 410, res.status + ' ' + res.text);
  }
  {
    const res = await call('POST', '/accounts/auth/reset-password/someuid/sometoken', { body: { password: 'NewPass1!' } });
    check('reset-password link retired -> 410', res.status === 410, res.status + ' ' + res.text);
  }

  // ===================== SEND / RESET PASSWORD OTP =====================
  {
    const res = await call('POST', '/accounts/auth/send-password-reset-otp', { body: { email: 'customer@audit.test' } });
    check('send-password-reset-otp happy -> 200', res.status === 200, res.status + ' ' + res.text);
    shapeCheck('send-password-reset-otp', res.json);
  }
  {
    // unknown email should still say success (no enumeration)
    const res = await call('POST', '/accounts/auth/send-password-reset-otp', { body: { email: 'unknown-nobody@audit.test' } });
    check('send-password-reset-otp unknown email -> 200 (no enumeration)', res.status === 200, res.status + ' ' + res.text);
  }
  {
    const otpRow = await prisma.emailOTP.findFirst({ where: { email: 'customer@audit.test' }, orderBy: { createdAt: 'desc' } });
    const res = await call('POST', '/accounts/auth/reset-password-otp', { body: { email: 'customer@audit.test', otp: otpRow.otp, password: 'NewPass1!' } });
    check('reset-password-otp happy -> 200', res.status === 200, res.status + ' ' + res.text);
  }
  {
    // reused otp
    const otpRow = await prisma.emailOTP.findFirst({ where: { email: 'customer@audit.test' }, orderBy: { createdAt: 'desc' } });
    const res = await call('POST', '/accounts/auth/reset-password-otp', { body: { email: 'customer@audit.test', otp: otpRow.otp, password: 'AnotherPass1!' } });
    check('reset-password-otp reused -> 400', res.status === 400, res.status + ' ' + res.text);
  }
  {
    const res = await call('POST', '/accounts/auth/reset-password-otp', { body: { email: 'customer@audit.test', otp: '000000', password: 'X' } });
    check('reset-password-otp wrong otp -> 400', res.status === 400, res.status + ' ' + res.text);
  }
  {
    // verify login now works with new password
    const res = await call('POST', '/accounts/auth/login', { body: { email: 'customer@audit.test', password: 'NewPass1!' } });
    check('login with new password after reset -> 200', res.status === 200, res.status + ' ' + res.text);
  }

  // ===================== PHONE OTP =====================
  {
    const res = await call('POST', '/accounts/auth/send-phone-otp', { body: { phone_number: '9123456789' } });
    check('send-phone-otp happy -> 200', res.status === 200, res.status + ' ' + res.text);
    shapeCheck('send-phone-otp', res.json);
  }
  {
    const res = await call('POST', '/accounts/auth/send-phone-otp', { body: { phone_number: 'not-a-phone' } });
    check('send-phone-otp bad number -> 400', res.status === 400, res.status + ' ' + res.text);
  }
  {
    const otpRow = await prisma.phoneOTP.findUnique({ where: { phone_number: '+919123456789' } });
    const res = await call('POST', '/accounts/auth/verify-phone-otp', { body: { phone_number: '9123456789', otp: otpRow.otp } });
    check('verify-phone-otp happy -> 200', res.status === 200, res.status + ' ' + res.text);
  }
  {
    const res = await call('POST', '/accounts/auth/verify-phone-otp', { body: { phone_number: '9123456789', otp: '111111' } });
    check('verify-phone-otp already verified -> 400', res.status === 400, res.status + ' ' + res.text);
  }
  {
    const res = await call('POST', '/accounts/auth/verify-phone-otp', { body: { phone_number: '9999999999', otp: '111111' } });
    check('verify-phone-otp no record -> 400', res.status === 400, res.status + ' ' + res.text);
  }
  {
    const res = await call('POST', '/accounts/auth/verify-phone-otp', { body: { phone_number: '9123456789' } });
    check('verify-phone-otp missing otp -> 400', res.status === 400, res.status + ' ' + res.text);
  }

  // ===================== EMAIL OTP =====================
  {
    const res = await call('POST', '/accounts/auth/send-email-otp', { body: { email: 'emailverify@audit.test' } });
    check('send-email-otp happy -> 200', res.status === 200, res.status + ' ' + res.text);
    shapeCheck('send-email-otp', res.json);
  }
  {
    const res = await call('POST', '/accounts/auth/send-email-otp', { body: {} });
    check('send-email-otp missing email -> 400', res.status === 400, res.status + ' ' + res.text);
  }
  {
    // no user exists with this email yet - verify should still work and just verify OTP
    const otpRow = await prisma.emailOTP.findFirst({ where: { email: 'emailverify@audit.test' }, orderBy: { createdAt: 'desc' } });
    const res = await call('POST', '/accounts/auth/verify-email-otp', { body: { email: 'emailverify@audit.test', otp: otpRow.otp } });
    check('verify-email-otp no matching user -> 200', res.status === 200, res.status + ' ' + res.text);
    shapeCheck('verify-email-otp no user', res.json);
  }
  {
    // register that email then verify otp -> should get tokens
    await call('POST', '/accounts/auth/register', { body: { email: 'emailverify2@audit.test', password: 'Passw0rd!x' } });
    await call('POST', '/accounts/auth/send-email-otp', { body: { email: 'emailverify2@audit.test' } });
    const otpRow = await prisma.emailOTP.findFirst({ where: { email: 'emailverify2@audit.test' }, orderBy: { createdAt: 'desc' } });
    const res = await call('POST', '/accounts/auth/verify-email-otp', { body: { email: 'emailverify2@audit.test', otp: otpRow.otp } });
    check('verify-email-otp with user -> 200 + tokens', res.status === 200 && !!res.json?.access, res.status + ' ' + res.text);
    shapeCheck('verify-email-otp with user', res.json);
  }
  {
    const res = await call('POST', '/accounts/auth/verify-email-otp', { body: { email: 'emailverify2@audit.test', otp: '000000' } });
    check('verify-email-otp already used -> 400', res.status === 400, res.status + ' ' + res.text);
  }

  // ===================== GOOGLE LOGIN (fails closed w/o real Google) =====================
  {
    // A syntactically plausible-looking but bogus JWT-shaped token clears the
    // request validator and reaches googleLogin, which must fail closed (401)
    // rather than 500 when verifyIdToken rejects it.
    const fakeJwt = 'eyJhbGciOiJSUzI1NiJ9.eyJmb28iOiJiYXIifQ.sig';
    const res = await call('POST', '/accounts/auth/google', { body: { idToken: fakeJwt } });
    check('google login bad token -> 401 (fails closed, not 500)', res.status === 401, res.status + ' ' + res.text);
    shapeCheck('google login bad token', res.json);
  }
  {
    // A genuinely malformed (non-JWT-shaped) token is rejected by the request
    // validator itself -- still fails clean (400), never 500.
    const res = await call('POST', '/accounts/auth/google', { body: { idToken: 'not-a-real-google-token' } });
    check('google login malformed token -> 400 (validator, not 500)', res.status === 400, res.status + ' ' + res.text);
  }
  {
    const res = await call('POST', '/accounts/auth/google', { body: {} });
    check('google login missing idToken -> 400 or 401 (not 500)', res.status === 400 || res.status === 401, res.status + ' ' + res.text);
  }

  // ===================== PASSWORD CHANGE =====================
  let pwChangeAccess;
  {
    const loginRes = await call('POST', '/accounts/auth/login', { body: { email: 'vendor@audit.test', password: 'Passw0rd!x' } });
    pwChangeAccess = loginRes.json?.access;
  }
  {
    const res = await call('PUT', '/accounts/auth/password/change', { as: pwChangeAccess, body: { oldPassword: 'WrongOld!', newPassword: 'NewVendorPass1!' } });
    check('password change wrong old password -> 401', res.status === 401, res.status + ' ' + res.text);
  }
  {
    const res = await call('PUT', '/accounts/auth/password/change', { as: pwChangeAccess, body: { oldPassword: 'Passw0rd!x', newPassword: 'NewVendorPass1!' } });
    check('password change happy -> 200', res.status === 200, res.status + ' ' + res.text);
  }
  {
    // old token should now be blacklisted (belt-and-braces)
    const res = await call('GET', '/accounts/auth/profile', { as: pwChangeAccess });
    check('token blacklisted after password change -> 401', res.status === 401, res.status + ' ' + res.text);
  }
  {
    const res = await call('PUT', '/accounts/auth/password/change', {});
    check('password change unauthenticated -> 401', res.status === 401, res.status + ' ' + res.text);
  }
  {
    // login with new password confirms it took
    const res = await call('POST', '/accounts/auth/login', { body: { email: 'vendor@audit.test', password: 'NewVendorPass1!' } });
    check('login with new vendor password -> 200', res.status === 200, res.status + ' ' + res.text);
  }

  // ===================== PUSH TOKEN =====================
  {
    const loginRes = await call('POST', '/accounts/auth/login', { body: { email: 'customer2@audit.test', password: 'Passw0rd!x' } });
    const acc = loginRes.json?.access;
    const res = await call('PUT', '/accounts/auth/push-token', { as: acc, body: { pushToken: 'ExponentPushToken[abc123]' } });
    check('push-token update happy -> 200', res.status === 200, res.status + ' ' + res.text);
  }
  {
    const res = await call('PUT', '/accounts/auth/push-token', { body: { pushToken: 'x' } });
    check('push-token unauthenticated -> 401', res.status === 401, res.status + ' ' + res.text);
  }

  // ===================== WEB PUSH (SSRF allowlist) =====================
  let webPushAccess;
  {
    const loginRes = await call('POST', '/accounts/auth/login', { body: { email: 'customer2@audit.test', password: 'Passw0rd!x' } });
    webPushAccess = loginRes.json?.access;
  }
  {
    // non-allowlisted URL should be rejected (SSRF guard)
    const res = await call('POST', '/accounts/auth/web-push', {
      as: webPushAccess,
      body: { endpoint: 'https://internal.evil.example.com/push', keys: { p256dh: 'a'.repeat(20), auth: 'b'.repeat(10) } },
    });
    check('web-push SSRF non-allowlisted endpoint -> 400', res.status === 400, res.status + ' ' + res.text);
  }
  {
    // localhost / internal IP attempt
    const res = await call('POST', '/accounts/auth/web-push', {
      as: webPushAccess,
      body: { endpoint: 'https://169.254.169.254/latest/meta-data', keys: { p256dh: 'a'.repeat(20), auth: 'b'.repeat(10) } },
    });
    check('web-push SSRF metadata IP -> 400', res.status === 400, res.status + ' ' + res.text);
  }
  {
    // valid allowlisted push service host
    const res = await call('POST', '/accounts/auth/web-push', {
      as: webPushAccess,
      body: { endpoint: 'https://fcm.googleapis.com/fcm/send/abc123', keys: { p256dh: 'a'.repeat(20), auth: 'b'.repeat(10) } },
    });
    check('web-push allowlisted endpoint -> 200', res.status === 200, res.status + ' ' + res.text);
  }
  {
    const res = await call('DELETE', '/accounts/auth/web-push', { as: webPushAccess, body: { endpoint: 'https://fcm.googleapis.com/fcm/send/abc123' } });
    check('web-push delete happy -> 200', res.status === 200, res.status + ' ' + res.text);
  }
  {
    const res = await call('POST', '/accounts/auth/web-push', { body: { endpoint: 'https://fcm.googleapis.com/fcm/send/abc', keys: {} } });
    check('web-push unauthenticated -> 401', res.status === 401, res.status + ' ' + res.text);
  }

  // ===================== ACCOUNT EXPORT =====================
  {
    const loginRes = await call('POST', '/accounts/auth/login', { body: { email: 'customer2@audit.test', password: 'Passw0rd!x' } });
    const acc = loginRes.json?.access;
    const res = await call('GET', '/accounts/auth/export', { as: acc });
    check('account export happy -> 200', res.status === 200, res.status + ' ' + res.text);
    shapeCheck('account export', res.json);
  }
  {
    const res = await call('GET', '/accounts/auth/export');
    check('account export unauthenticated -> 401', res.status === 401, res.status + ' ' + res.text);
  }

  // ===================== ACCOUNT ERASURE =====================
  let erasureAccess;
  {
    // customer2 already has a verified profile from the seed, so erasure runs
    // through `protect`'s ordinary path instead of the (correct) 403 an
    // unverified, profile-less account gets.
    const loginRes = await call('POST', '/accounts/auth/login', { body: { email: 'customer2@audit.test', password: 'Passw0rd!x' } });
    erasureAccess = loginRes.json?.access;
  }
  {
    const res = await call('DELETE', '/accounts/auth/account', { as: erasureAccess });
    check('account erasure happy -> 200', res.status === 200, res.status + ' ' + res.text);
    shapeCheck('account erasure', res.json);
  }
  {
    const res = await call('DELETE', '/accounts/auth/account');
    check('account erasure unauthenticated -> 401', res.status === 401, res.status + ' ' + res.text);
  }

  console.log(`\n===== RESULTS: ${pass} passed, ${fail} failed =====`);
  if (failures.length) {
    console.log(JSON.stringify(failures, null, 2));
  }

  await shutdown();
  process.exit(fail > 0 ? 1 : 0);
}

main().catch(async (e) => {
  console.error('FATAL', e);
  try { await shutdown(); } catch {}
  process.exit(1);
});
