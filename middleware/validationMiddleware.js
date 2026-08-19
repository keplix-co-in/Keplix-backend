/**
 * Wraps a Zod schema as request-body validation middleware.
 *
 * Note on the error shape: Zod v4 exposes validation problems as `error.issues`.
 * This previously branched on `error.errors`, which was the v3 name and does
 * not exist in v4 — so the branch never fired and EVERY validation failure in
 * the API fell through to next(error) and came back as a 500
 * INTERNAL_SERVER_ERROR instead of a 400. Clients were told the server had
 * broken when they had simply sent a bad field, and genuine server faults were
 * indistinguishable from bad input in the logs.
 *
 * Both names are accepted below so this keeps working if Zod is up- or
 * down-graded.
 */
export const validateRequest = (schema) => async (req, res, next) => {
  try {
<<<<<<< HEAD
    // Validate request body against the schema
=======
>>>>>>> eaee52b12e147de79c7937b99b425177c5de381d
    const parsedData = await schema.parseAsync(req.body);
    req.body = parsedData;
    next();
  } catch (error) {
    const issues = error?.issues ?? error?.errors;

    if (Array.isArray(issues)) {
      return res.status(400).json({
        success: false,
        message: 'Validation Error',
        code: 'VALIDATION_ERROR',
        errors: issues.map((issue) => ({
          field: Array.isArray(issue.path) ? issue.path.join('.') : String(issue.path ?? ''),
          message: issue.message,
        })),
      });
    }

    // Genuinely unexpected — let the error handler produce a 500.
    next(error);
  }
};
