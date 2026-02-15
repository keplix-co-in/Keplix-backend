export const validateRequest = (schema) => async (req, res, next) => {
  try {
    // Validate request body against the schema
    const parsedData = await schema.parseAsync(req.body);
    req.body = parsedData;
    next();
  } catch (error) {
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
