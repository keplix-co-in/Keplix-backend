import z from 'zod';

export const loginSchema = z.object({
<<<<<<< HEAD
  email: z.string().email({message: "Invalid email address"}),
  password: z.string().min(1, {message: "Password is required"})
})
=======
  email: z.string().email({ message: 'Invalid email address' }),
  password: z.string().min(1, { message: 'Password is required' }),
});

export const refreshTokenSchema = z.object({
  refreshToken: z.string().min(1, { message: 'Refresh token is required' }),
});
>>>>>>> eaee52b12e147de79c7937b99b425177c5de381d
