import swaggerJsdoc from "swagger-jsdoc";

// Was hardcoded to "http://0.0.0.0:8080" (audit #135/#167) -- "Try it out" in
// the Swagger UI sent every request there regardless of where the server was
// actually running, including in production on Cloud Run. PUBLIC_WEB_BASE_URL
// isn't right here either (that's the website's origin, not the API's); this
// falls back to the local dev port when nothing else is set.
const serverUrl =
  process.env.API_BASE_URL || `http://localhost:${process.env.PORT || 8000}`;

const options = {
  definition: {
    openapi: "3.0.0",
    info: {
      title: "Keplix API",
      version: "1.0.0",
      description: "API documentation for Keplix backend",
    },
    servers: [
      {
        url: serverUrl,
      },
    ],

    
    tags: [
      { name: "Auth", description: "Authentication APIs" },
      { name: "User", description: "User APIs" },
      { name: "Vendor", description: "Vendor APIs" },
      { name: "Admin", description: "Admin APIs" },
    ],

    
    components: {
      securitySchemes: {
        bearerAuth: {
          type: "http",
          scheme: "bearer",
          bearerFormat: "JWT",
        },
      },
    },
    security: [
      {
        bearerAuth: [],
      },
    ],
  },

  
  apis: ["./routes/**/*.js"],
};

const swaggerSpec = swaggerJsdoc(options);

export default swaggerSpec;