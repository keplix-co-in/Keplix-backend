export const validateRequest = (schema) => async (req, res, next) => {
  try {
    // Validate request body against the schema
    // parse will throw an error if validation fails
    // We update req.body with the parsed/sanitized data (Zod strips unknown keys by default if configured, or we can use safeParse)
    const parsedData = await schema.parseAsync(req.body);
    req.body = parsedData;
    next();
  } catch (error) {
    if (error.errors) {
      // Zod validation error
      return res.status(400).json({
        message: 'Validation Error',
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
