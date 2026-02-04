export const validateRequest = (schema) => async (req, res, next) => {
  console.log('📋 [Validation] Path:', req.path);
  console.log('📋 [Validation] Content-Type:', req.headers['content-type']);
  console.log('📋 [Validation] Raw Body:', JSON.stringify(req.body, null, 2));
  console.log('📋 [Validation] Body keys:', Object.keys(req.body));
  
  try {
    // Validate request body against the schema
    const parsedData = await schema.parseAsync(req.body);
    console.log('✅ [Validation] Success! Parsed data:', parsedData);
    req.body = parsedData;
    next();
  } catch (error) {
    console.error('❌ [Validation] Failed:', error);
    if (error.errors) {
      // Zod validation error
      return res.status(400).json({
        success: false,
        message: 'Validation Error',
        code: 'VALIDATION_ERROR',
        errors: error.errors.map((err) => ({
          field: err.path.join('.'),
          message: err.message,
        })),
      });
    }
    // Unexpected error
    next(error);
  }
};
