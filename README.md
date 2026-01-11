# Keplix Backend

The robust Node.js backend for the Keplix Service Marketplace application. This system manages authentication, user/vendor workflows, bookings, services, and payments using a strict **User vs. Vendor** architecture.

##  Tech Stack

*   **Runtime:** Node.js
*   **Framework:** Express.js
*   **Database:** SQLite (Development) / PostgreSQL (Production ready)
*   **ORM:** Prisma
*   **Validation:** Zod
*   **Authentication:** JWT (JSON Web Tokens)
*   **File Uploads:** Multer

---

##  Project Structure

The project follows a strict domain-driven separation between **User** (Customer) and **Vendor** (Service Provider) logic.

```text
keplix-backend/
 controllers/          # Business logic
    user/             # Customer-specific logic (Bookings, Reviews, etc.)
    vendor/           # Vendor-specific logic (Inventory, Services, etc.)
    authController.js # Shared Authentication
 middleware/           # Request processing
    authMiddleware.js # JWT verification
    roleMiddleware.js # Vendor/Admin role checks
    validateRequest.js# Zod schema validation
    ...
 prisma/               # Database
    schema.prisma     # Data models
    dev.db            # SQLite database file
 routes/               # API Endpoints
    user/             # Routes for customers
    vendor/           # Routes for service providers
    auth.js           # Auth routes
 validators/           # Zod Schemas
    user/             # Validation for user inputs
    vendor/           # Validation for vendor inputs
 server.js             # Entry point
```

---

##  Getting Started

### 1. Prerequisites
*   Node.js (v18+)
*   npm

### 2. Installation

Clone the repository and install dependencies:

```bash
cd keplix-backend
npm install
```

### 3. Database Setup

Initialize the database schema and generate the Prisma Client:

```bash
# Push schema to the database
npx prisma db push

# (Optional) Seed the database with test data
node prisma/seed.js
```

### 4. Running the Server

**Development Mode** (with auto-restart):
```bash
npm run dev
```

The server will start at: `http://localhost:8000`

---

##  Key API Endpoints

### Authentication
*   `POST /accounts/auth/signup/` - Register a new user or vendor.
*   `POST /accounts/auth/login/` - Login and receive JWT.
*   `POST /accounts/auth/send-phone-otp/` - Mobile verification.

### Vendor API (`/interactions/api/vendor/...` & `/service_api/vendor/...`)
*   `GET /service_api/vendor/services` - List my services.
*   `POST /service_api/vendor/services/create` - Add a new service.
*   `GET /interactions/api/vendor/bookings` - View incoming booking requests.
*   `PATCH /interactions/api/vendor/bookings/:id/status` - Accept/Reject bookings.
*   `GET /interactions/api/vendor/inventory` - Manage stock.

### User API (`/interactions/api/user/...` & `/service_api/user/...`)
*   `GET /service_api/user/services` - Browse all available services.
*   `POST /interactions/api/user/bookings/create` - Book a service.
*   `GET /interactions/api/user/bookings` - View my booking history.
*   `POST /interactions/api/user/reviews/create` - Leave a review.

---

##  Database Management (Prisma)

*   **View Data GUI:**
    ```bash
    npm run prisma:studio
    ```
    (Runs on port 5556)

*   **Update Schema:**
    If you modify `prisma/schema.prisma`:
    ```bash
    npx prisma db push
    ```

---

##  Security Features
*   **Role-Based Access Control:** Middleware ensures Vendors cannot access User routes and vice-versa where appropriate.
*   **Input Validation:** All incoming data is sanitized and validated using Zod schemas.
*   **Secure Headers:** Production-ready middleware stack.
*   **Request Logging:** Console logging for monitoring traffic status and latency.
