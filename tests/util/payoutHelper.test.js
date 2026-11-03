import { jest } from '@jest/globals';

// The real helper is tested here against a fake RazorpayX client. Before
// 2026-11-03 every test mocked payoutHelper wholesale, which is how calls to
// SDK methods that don't exist (razorpayX.contacts/payouts) reached prod.

const mockPrisma = {
  vendorPayoutAccount: {
    findUnique: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
  },
};

jest.unstable_mockModule('../../util/prisma.js', () => ({ default: mockPrisma }));
jest.unstable_mockModule('../../util/logger.js', () => ({
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

const {
  setupVendorPayoutAccount,
  updateVendorPayoutAccount,
  initiateVendorPayout,
  fetchVendorPayout,
  describePayoutFailure,
  __setRazorpayXClientForTests,
} = await import('../../util/payoutHelper.js');

const fakeClient = () => ({
  createContact: jest.fn().mockResolvedValue({ id: 'cont_1' }),
  createFundAccount: jest.fn().mockResolvedValue({ id: 'fa_new' }),
  fetchFundAccount: jest.fn().mockResolvedValue({ id: 'fa_1', account_type: 'bank_account' }),
  deactivateFundAccount: jest.fn().mockResolvedValue({ id: 'fa_old', active: false }),
  createPayout: jest.fn().mockResolvedValue({ id: 'pout_1', status: 'processing' }),
  fetchPayout: jest.fn().mockResolvedValue({ id: 'pout_1', status: 'processed' }),
});

let client;
const ORIGINAL_ACCOUNT = process.env.RAZORPAYX_ACCOUNT_NUMBER;

beforeEach(() => {
  jest.clearAllMocks();
  client = fakeClient();
  __setRazorpayXClientForTests(client);
  process.env.RAZORPAYX_ACCOUNT_NUMBER = '1234567890123456';
});

afterAll(() => {
  __setRazorpayXClientForTests(null);
  if (ORIGINAL_ACCOUNT === undefined) delete process.env.RAZORPAYX_ACCOUNT_NUMBER;
  else process.env.RAZORPAYX_ACCOUNT_NUMBER = ORIGINAL_ACCOUNT;
});

describe('setupVendorPayoutAccount', () => {
  test('creates a contact + bank fund account and saves them', async () => {
    mockPrisma.vendorPayoutAccount.findUnique.mockResolvedValue(null);
    mockPrisma.vendorPayoutAccount.create.mockImplementation(async ({ data }) => ({ id: 1, ...data }));

    const acct = await setupVendorPayoutAccount(948, {
      business_name: 'Speedy Motors',
      bank_account_holder_name: 'Asha Rao',
      bank_account_number: '000111222333',
      ifsc_code: 'HDFC0000001',
      phone: '9876543210',
    });

    expect(client.createContact).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'Speedy Motors', type: 'vendor', reference_id: 'vendor_948' })
    );
    expect(client.createFundAccount).toHaveBeenCalledWith({
      contact_id: 'cont_1',
      account_type: 'bank_account',
      bank_account: { name: 'Asha Rao', ifsc: 'HDFC0000001', account_number: '000111222333' },
    });
    expect(acct).toEqual(expect.objectContaining({ vendorId: 948, contactId: 'cont_1', fundAccountId: 'fa_new' }));
  });

  test('UPI-only vendor gets a vpa fund account', async () => {
    mockPrisma.vendorPayoutAccount.findUnique.mockResolvedValue(null);
    mockPrisma.vendorPayoutAccount.create.mockResolvedValue({});
    await setupVendorPayoutAccount(5, { business_name: 'X', upi_id: 'x@upi' });
    expect(client.createFundAccount).toHaveBeenCalledWith({
      contact_id: 'cont_1',
      account_type: 'vpa',
      vpa: { address: 'x@upi' },
    });
  });

  test('an existing payout account is returned without calling RazorpayX', async () => {
    mockPrisma.vendorPayoutAccount.findUnique.mockResolvedValue({ vendorId: 5, fundAccountId: 'fa_1' });
    await setupVendorPayoutAccount(5, { upi_id: 'x@upi' });
    expect(client.createContact).not.toHaveBeenCalled();
  });

  test('a RazorpayX failure is thrown so the profile controller can report it', async () => {
    mockPrisma.vendorPayoutAccount.findUnique.mockResolvedValue(null);
    client.createContact.mockRejectedValue(new Error('RazorpayX POST /contacts failed (HTTP 401)'));
    await expect(setupVendorPayoutAccount(5, { upi_id: 'x@upi' })).rejects.toThrow(/HTTP 401/);
    expect(mockPrisma.vendorPayoutAccount.create).not.toHaveBeenCalled();
  });
});

describe('updateVendorPayoutAccount', () => {
  const existing = { vendorId: 5, contactId: 'cont_1', fundAccountId: 'fa_old' };

  test('new details: creates the new fund account, stores it, THEN deactivates the old one', async () => {
    mockPrisma.vendorPayoutAccount.findUnique.mockResolvedValue(existing);
    mockPrisma.vendorPayoutAccount.update.mockResolvedValue({});
    client.fetchFundAccount.mockResolvedValue({ id: 'fa_old', account_type: 'vpa', vpa: { address: 'old@upi' } });
    await updateVendorPayoutAccount(5, { upi_id: 'new@upi' });
    expect(mockPrisma.vendorPayoutAccount.update).toHaveBeenCalledWith({
      where: { vendorId: 5 },
      data: { fundAccountId: 'fa_new' },
    });
    expect(client.deactivateFundAccount).toHaveBeenCalledWith('fa_old');
    expect(client.createFundAccount.mock.invocationCallOrder[0])
      .toBeLessThan(client.deactivateFundAccount.mock.invocationCallOrder[0]);
  });

  test('unchanged UPI details (a plain profile save) touch nothing', async () => {
    mockPrisma.vendorPayoutAccount.findUnique.mockResolvedValue(existing);
    client.fetchFundAccount.mockResolvedValue({ id: 'fa_old', account_type: 'vpa', vpa: { address: 'x@upi' } });
    const res = await updateVendorPayoutAccount(5, { upi_id: 'x@upi' });
    expect(res).toBe(existing);
    expect(client.createFundAccount).not.toHaveBeenCalled();
    expect(client.deactivateFundAccount).not.toHaveBeenCalled();
  });

  test('unchanged bank details (IFSC case ignored) touch nothing', async () => {
    mockPrisma.vendorPayoutAccount.findUnique.mockResolvedValue(existing);
    client.fetchFundAccount.mockResolvedValue({
      id: 'fa_old', account_type: 'bank_account',
      bank_account: { name: 'Asha Rao', ifsc: 'HDFC0000001', account_number: '000111' },
    });
    await updateVendorPayoutAccount(5, { bank_account_holder_name: 'Asha Rao', ifsc_code: 'hdfc0000001', bank_account_number: '000111' });
    expect(client.createFundAccount).not.toHaveBeenCalled();
  });

  test('a changed holder name on the same account does replace it', async () => {
    mockPrisma.vendorPayoutAccount.findUnique.mockResolvedValue(existing);
    mockPrisma.vendorPayoutAccount.update.mockResolvedValue({});
    client.fetchFundAccount.mockResolvedValue({
      id: 'fa_old', account_type: 'bank_account',
      bank_account: { name: 'Old Name', ifsc: 'HDFC0000001', account_number: '000111' },
    });
    await updateVendorPayoutAccount(5, { bank_account_holder_name: 'Asha Rao', ifsc_code: 'HDFC0000001', bank_account_number: '000111' });
    expect(client.createFundAccount).toHaveBeenCalled();
  });

  test('if creating the new account fails, the old one stays active', async () => {
    mockPrisma.vendorPayoutAccount.findUnique.mockResolvedValue(existing);
    client.fetchFundAccount.mockResolvedValue({ id: 'fa_old', account_type: 'vpa', vpa: { address: 'old@upi' } });
    client.createFundAccount.mockRejectedValue(new Error('RazorpayX POST /fund_accounts failed (HTTP 400): invalid vpa'));
    await expect(updateVendorPayoutAccount(5, { upi_id: 'bad@upi' })).rejects.toThrow(/invalid vpa/);
    expect(client.deactivateFundAccount).not.toHaveBeenCalled();
    expect(mockPrisma.vendorPayoutAccount.update).not.toHaveBeenCalled();
  });

  test('RazorpayX returning the same id never deactivates the stored account', async () => {
    mockPrisma.vendorPayoutAccount.findUnique.mockResolvedValue(existing);
    mockPrisma.vendorPayoutAccount.update.mockResolvedValue({});
    client.fetchFundAccount.mockRejectedValue(new Error('timeout'));
    client.createFundAccount.mockResolvedValue({ id: 'fa_old' });
    await updateVendorPayoutAccount(5, { upi_id: 'x@upi' });
    expect(client.deactivateFundAccount).not.toHaveBeenCalled();
  });

  test('a failed deactivate does not fail the save', async () => {
    mockPrisma.vendorPayoutAccount.findUnique.mockResolvedValue(existing);
    mockPrisma.vendorPayoutAccount.update.mockResolvedValue({ fundAccountId: 'fa_new' });
    client.fetchFundAccount.mockResolvedValue({ id: 'fa_old', account_type: 'vpa', vpa: { address: 'old@upi' } });
    client.deactivateFundAccount.mockRejectedValue(new Error('HTTP 500'));
    await expect(updateVendorPayoutAccount(5, { upi_id: 'new@upi' })).resolves.toEqual({ fundAccountId: 'fa_new' });
  });

  test('with no existing account it sets one up instead', async () => {
    mockPrisma.vendorPayoutAccount.findUnique.mockResolvedValue(null);
    mockPrisma.vendorPayoutAccount.create.mockResolvedValue({});
    await updateVendorPayoutAccount(5, { business_name: 'X', upi_id: 'x@upi' });
    expect(client.deactivateFundAccount).not.toHaveBeenCalled();
    expect(client.createContact).toHaveBeenCalled();
  });
});

describe('initiateVendorPayout', () => {
  const payment = { id: 77, vendorAmount: '450.50', method: 'razorpay' };
  const activeAccount = { vendorId: 5, fundAccountId: 'fa_1', isActive: true };

  test('sends the payout in paise with the idempotency key and returns its real status', async () => {
    mockPrisma.vendorPayoutAccount.findUnique.mockResolvedValue(activeAccount);
    const res = await initiateVendorPayout(payment, 5);

    expect(client.createPayout).toHaveBeenCalledWith(
      expect.objectContaining({
        account_number: '1234567890123456',
        fund_account_id: 'fa_1',
        amount: 45050,
        currency: 'INR',
        mode: 'IMPS',
        purpose: 'payout',
        reference_id: 'payment_77',
      }),
      'payout_payment_77'
    );
    expect(res).toEqual({ success: true, payoutId: 'pout_1', status: 'processing' });
  });

  test('a UPI fund account is paid over UPI, not IMPS', async () => {
    mockPrisma.vendorPayoutAccount.findUnique.mockResolvedValue(activeAccount);
    client.fetchFundAccount.mockResolvedValue({ id: 'fa_1', account_type: 'vpa' });
    await initiateVendorPayout(payment, 5);
    expect(client.createPayout.mock.calls[0][0].mode).toBe('UPI');
  });

  test('a payout RazorpayX rejects on the spot is NOT reported as success', async () => {
    mockPrisma.vendorPayoutAccount.findUnique.mockResolvedValue(activeAccount);
    client.createPayout.mockResolvedValue({ id: 'pout_2', status: 'rejected', status_details: { description: 'compliance' } });
    const res = await initiateVendorPayout(payment, 5);
    expect(res).toEqual(expect.objectContaining({ success: false, terminal: true, payoutId: 'pout_2', status: 'rejected' }));
    expect(res.error).toMatch(/rejected: compliance/);
  });

  test('uses the idempotency key the worker passes (new key after a refusal)', async () => {
    mockPrisma.vendorPayoutAccount.findUnique.mockResolvedValue(activeAccount);
    await initiateVendorPayout(payment, 5, { idempotencyKey: 'payout_payment_77_r1' });
    expect(client.createPayout.mock.calls[0][1]).toBe('payout_payment_77_r1');
  });

  test('missing account number fails without calling RazorpayX', async () => {
    delete process.env.RAZORPAYX_ACCOUNT_NUMBER;
    mockPrisma.vendorPayoutAccount.findUnique.mockResolvedValue(activeAccount);
    const res = await initiateVendorPayout(payment, 5);
    expect(res).toEqual({ success: false, error: 'RAZORPAYX_ACCOUNT_NUMBER is not configured' });
    expect(client.createPayout).not.toHaveBeenCalled();
  });

  test('vendor without a payout account fails', async () => {
    mockPrisma.vendorPayoutAccount.findUnique.mockResolvedValue(null);
    const res = await initiateVendorPayout(payment, 5);
    expect(res.success).toBe(false);
    expect(client.createPayout).not.toHaveBeenCalled();
  });

  test('an unknown payment method reports why, under the key the worker reads', async () => {
    mockPrisma.vendorPayoutAccount.findUnique.mockResolvedValue(activeAccount);
    const res = await initiateVendorPayout({ ...payment, method: 'cash' }, 5);
    expect(res).toEqual({ success: false, error: 'Unknown payment method: cash' });
    expect(client.createPayout).not.toHaveBeenCalled();
  });

  test('a gateway error comes back as a failure, not a crash', async () => {
    mockPrisma.vendorPayoutAccount.findUnique.mockResolvedValue(activeAccount);
    client.createPayout.mockRejectedValue(new Error('RazorpayX POST /payouts failed (HTTP 400): The RazorpayX Account number is invalid.'));
    const res = await initiateVendorPayout(payment, 5);
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/Account number is invalid/);
    expect(res.terminal).toBeUndefined(); // an HTTP error is retried with the same key
  });
});

describe('fetchVendorPayout / describePayoutFailure', () => {
  test('fetchVendorPayout asks RazorpayX for the payout', async () => {
    await expect(fetchVendorPayout('pout_1')).resolves.toEqual({ id: 'pout_1', status: 'processed' });
    expect(client.fetchPayout).toHaveBeenCalledWith('pout_1');
  });

  test('describePayoutFailure includes the status and the reason', () => {
    const msg = describePayoutFailure({ id: 'p', status: 'reversed', status_details: { description: 'beneficiary bank down' } });
    expect(msg).toMatch(/reversed/);
    expect(msg).toMatch(/beneficiary bank down/);
  });
});
