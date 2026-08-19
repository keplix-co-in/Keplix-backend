import swaggerJsdoc from "swagger-jsdoc";

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
        url: "http://0.0.0.0:8080",
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