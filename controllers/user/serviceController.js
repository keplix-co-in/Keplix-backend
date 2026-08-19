<<<<<<< HEAD
﻿import prisma from "../../util/prisma.js";



// @desc    Get All Services (Public)
// @route   GET /service_api/user/services
export const getAllServices = async (req, res) => {
  try {
    //query params
    const { page = 1, limit = 10, search, latitude, longitude, radius = 50, online_only } = req.query;

=======
import prisma from "../../util/prisma.js";
import { Prisma } from "@prisma/client";

/**
 * Get All Services (Public)
 * Retrieves a list of services with optional search, location-based filtering, and pagination.
 * If latitude and longitude are provided, filtering and sorting are done at the database level.
 *
 * @param {Object} req - Express request object
 * @param {Object} req.query - Query parameters
 * @param {number} [req.query.page=1] - Page number for pagination
 * @param {number} [req.query.limit=10] - Number of items per page
 * @param {string} [req.query.search] - Search keyword for name, category, or description
 * @param {number} [req.query.latitude] - User latitude for distance calculation
 * @param {number} [req.query.longitude] - User longitude for distance calculation
 * @param {number} [req.query.radius=50] - Search radius in kilometers
 * @param {string} [req.query.online_only] - Filter by online vendors only ('true'/'false')
 * @param {Object} res - Express response object
 */
export const getAllServices = async (req, res) => {
  try {
    const { page = 1, limit = 10, search, latitude, longitude, radius = 50, online_only } = req.query;
>>>>>>> eaee52b12e147de79c7937b99b425177c5de381d
    const skip = (page - 1) * limit;
    const searchRadius = parseFloat(radius);
    const userLat = latitude ? parseFloat(latitude) : null;
    const userLon = longitude ? parseFloat(longitude) : null;

    let services = [];
    let total = 0;

    // Use Raw SQL for location-based filtering to ensure correct pagination and sorting
    if (userLat !== null && userLon !== null) {
      const searchQuery = search ? `%${search}%` : null;
      const isOnlineOnly = online_only === 'true';

      // Haversine formula in SQL: 6371 * acos(cos(rad(lat1)) * cos(rad(lat2)) * cos(rad(lon2) - rad(lon1)) + sin(rad(lat1)) * sin(rad(lat2)))
      // We use LEAST/GREATEST to avoid floating point errors with acos
      const distanceSql = Prisma.sql`
        (6371 * acos(
          LEAST(1, GREATEST(-1, 
            cos(radians(${userLat})) * cos(radians(vp.latitude)) * 
            cos(radians(vp.longitude) - radians(${userLon})) + 
            sin(radians(${userLat})) * sin(radians(vp.latitude))
          ))
        ))
      `;

      const whereConditions = [
        Prisma.sql`s.is_active = true`,
        Prisma.sql`vp.latitude IS NOT NULL`,
        Prisma.sql`vp.longitude IS NOT NULL`,
        Prisma.sql`${distanceSql} <= ${searchRadius}`
      ];

      if (searchQuery) {
        whereConditions.push(Prisma.sql`(s.name ILIKE ${searchQuery} OR s.category ILIKE ${searchQuery} OR s.description ILIKE ${searchQuery})`);
      }

      if (isOnlineOnly) {
        whereConditions.push(Prisma.sql`vp.is_online = true`);
      }

      const whereClause = Prisma.join(whereConditions, ' AND ');

      services = await prisma.$queryRaw`
        SELECT 
          s.*, 
          vp.business_name as vendor_name, 
          vp.image as vendor_image, 
          vp.cover_image, 
          vp.address as vendor_address,
          vp.city as vendor_city,
          vp.rating as vendor_rating,
          vp."numReviews" as vendor_reviews,
          ${distanceSql} as distance
        FROM "Service" s
        JOIN "VendorProfile" vp ON s."vendorId" = vp."userId"
        WHERE ${whereClause}
        ORDER BY distance ASC
        LIMIT ${Number(limit)} OFFSET ${Number(skip)}
      `;

      // For total count in location search
      const countResult = await prisma.$queryRaw`
        SELECT COUNT(*)::int as total
        FROM "Service" s
        JOIN "VendorProfile" vp ON s."vendorId" = vp."userId"
        WHERE ${whereClause}
      `;
      total = countResult[0]?.total || 0;
    } else {
      // Standard Prisma query when location is not provided
      let where = { is_active: true };

      if (search) {
        where.OR = [
          { name: { contains: search, mode: "insensitive" } },
          { category: { contains: search, mode: "insensitive" } },
          { description: { contains: search, mode: "insensitive" } },
        ];
      }

      if (online_only === 'true') {
        where.vendor = { vendorProfile: { is_online: true } };
      }

      services = await prisma.service.findMany({
        where,
        skip: Number(skip),
        take: Number(limit),
        include: { vendor: { include: { vendorProfile: true } } },
        orderBy: { id: "desc" },
      });

      total = await prisma.service.count({ where });
    }

<<<<<<< HEAD
    // Filter by online vendors if requested
    if (online_only === 'true') {
      const onlineVendors = await prisma.vendorProfile.findMany({
        where: { is_online: true },
        select: { userId: true }
      });
      const vendorIds = onlineVendors.map(v => v.userId);
      where.vendorId = { in: vendorIds };
    }

    // Get all services with vendor profile info
    const services = await prisma.service.findMany({
      where,
      skip: Number(skip),
      take: Number(limit),
      include: { vendor: { include: { vendorProfile: true } } },
      orderBy: { id: "desc" },
    });

    //Count query
    const total = await prisma.service.count({ where });

    // Enrich data for frontend parity and calculate distances if location provided
    const enrichedServices = services.map((service) => {
      let distance = null;
      let distanceText = null;

      // Calculate distance if user location and vendor location are available
      if (latitude && longitude && service.vendor?.vendorProfile?.latitude && service.vendor?.vendorProfile?.longitude) {
        const lat1 = parseFloat(latitude);
        const lon1 = parseFloat(longitude);
        const lat2 = parseFloat(service.vendor.vendorProfile.latitude);
        const lon2 = parseFloat(service.vendor.vendorProfile.longitude);

        const R = 6371; // Earth's radius in kilometers
        const dLat = (lat2 - lat1) * (Math.PI / 180);
        const dLon = (lon2 - lon1) * (Math.PI / 180);
        const a =
          Math.sin(dLat / 2) * Math.sin(dLat / 2) +
          Math.cos(lat1 * (Math.PI / 180)) *
            Math.cos(lat2 * (Math.PI / 180)) *
            Math.sin(dLon / 2) *
            Math.sin(dLon / 2);
        const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
        distance = R * c;

        // Format distance text
        if (distance < 1) {
          distanceText = `${Math.round(distance * 1000)}m away`;
        } else {
          distanceText = `${distance.toFixed(1)}km away`;
        }
      }

      return {
        ...service,
        image_url: service.image_url
          ? service.image_url.startsWith("http") 
            ? service.image_url 
            : `${req.protocol}://${req.get("host")}${service.image_url}`
          : null,
        image: service.image_url
          ? service.image_url.startsWith("http") 
            ? service.image_url 
            : `${req.protocol}://${req.get("host")}${service.image_url}`
          : null,
        vendor_name: service.vendor?.vendorProfile?.business_name || "Vendor",
        vendor_image: service.vendor?.vendorProfile?.image || null,
        cover_image: service.vendor?.vendorProfile?.cover_image || null,
        distance: distance,
        distanceText: distanceText,
        vendor_address: service.vendor?.vendorProfile?.address || null,
        vendor_city: service.vendor?.vendorProfile?.city || null,
      };
    });

    // Filter by radius if location provided and sort by distance
    let filteredServices = enrichedServices;
    if (latitude && longitude) {
      filteredServices = enrichedServices
        .filter(service => service.distance !== null && service.distance <= parseFloat(radius))
        .sort((a, b) => (a.distance || Infinity) - (b.distance || Infinity));
    }

    res.json(filteredServices);
=======
    // A second, batched query rather than touching the raw-SQL branch above:
    // that branch is hand-written Haversine SQL, and threading a JOIN through
    // it for a handful of segment-price rows per service is a lot of risk for
    // very little — a single IN(...) lookup keyed by the ids already fetched
    // does the same job for both branches identically.
    const serviceIds = services.map((s) => s.id);
    const segmentPriceRows = serviceIds.length
      ? await prisma.serviceSegmentPrice.findMany({ where: { serviceId: { in: serviceIds } } })
      : [];
    const segmentPricesByService = new Map();
    for (const row of segmentPriceRows) {
      const list = segmentPricesByService.get(row.serviceId) ?? [];
      list.push({ segment: row.segment, price: parseFloat(row.price.toString()) });
      segmentPricesByService.set(row.serviceId, list);
    }

    // Standardize the response format
    const enrichedServices = services.map((service) => {
      // If it came from raw query, service properties are already at top level
      // If it came from Prisma findMany, we need to extract from includes
      const vendorProfile = service.vendor?.vendorProfile || {};
      const distance = service.distance !== undefined ? parseFloat(service.distance) : null;
      
      let distanceText = null;
      if (distance !== null) {
        distanceText = distance < 1 ? `${Math.round(distance * 1000)}m away` : `${distance.toFixed(1)}km away`;
      }

      const imgUrl = service.image_url;
      const fullImageUrl = imgUrl
        ? imgUrl.startsWith("http") 
          ? imgUrl 
          : `${req.protocol}://${req.get("host")}${imgUrl.startsWith('/') ? '' : '/'}${imgUrl}`
        : null;

      return {
        id: service.id,
        name: service.name,
        description: service.description,
        price: service.price,
        duration: service.duration,
        category: service.category,
        image_url: fullImageUrl,
        image: fullImageUrl,
        is_active: service.is_active,
        is_featured: service.is_featured,
        vendorId: service.vendorId,
        vendor_name: service.vendor_name || vendorProfile.business_name || "Vendor",
        vendor_image: service.vendor_image || vendorProfile.image || null,
        cover_image: service.cover_image || vendorProfile.cover_image || null,
        distance: distance,
        distanceText: distanceText,
        vendor_address: service.vendor_address || vendorProfile.address || null,
        vendor_city: service.vendor_city || vendorProfile.city || null,
        // Dual-sourced like the fields above: the raw-SQL branch (used when the
        // caller sends coordinates) aliases these columns, while the Prisma
        // branch reaches them through the included vendorProfile. Both must be
        // populated or a card would show a rating only for located users.
        // ?? rather than || so a genuine 0 rating isn't swapped for the fallback.
        vendor_rating: service.vendor_rating ?? vendorProfile.rating ?? null,
        vendor_reviews: service.vendor_reviews ?? vendorProfile.numReviews ?? 0,
        // Empty array (not omitted) for a service with no segment pricing, so
        // the app can do `segment_prices.length > 0` without an extra null
        // check — the same convention `is_active`/`is_featured` already use.
        segment_prices: segmentPricesByService.get(service.id) ?? [],
        vehicle_note: service.vehicle_note ?? null,
      };
    });

    res.json(enrichedServices);
>>>>>>> eaee52b12e147de79c7937b99b425177c5de381d
  } catch (error) {
    console.error("Error in getAllServices:", error);
    res.status(500).json({ message: "Server Error" });
  }
};

/**
 * Get Service By ID (Public)
 * Retrieves full details of a specific service by its ID.
 *
 * @param {Object} req - Express request object
 * @param {Object} req.params - URL parameters
 * @param {number} req.params.id - Service ID
 * @param {Object} res - Express response object
 */
export const getServiceById = async (req, res) => {
  try {
    const service = await prisma.service.findUnique({
      where: { id: parseInt(req.params.id) },
      include: { vendor: { include: { vendorProfile: true } }, segmentPrices: true },
    });

    if (service) {
      const imgUrl = service.image_url;
      const fullImageUrl = imgUrl
        ? imgUrl.startsWith("http")
          ? imgUrl
          : `${req.protocol}://${req.get("host")}${imgUrl.startsWith('/') ? '' : '/'}${imgUrl}`
        : null;

      const enrichedService = {
        ...service,
<<<<<<< HEAD
        image_url: service.image_url
          ? service.image_url.startsWith("http")
            ? service.image_url
            : `${req.protocol}://${req.get("host")}${service.image_url}`
          : null,

        image: service.image_url
          ? service.image_url.startsWith("http")
            ? service.image_url
            : `${req.protocol}://${req.get("host")}${service.image_url}`
          : null,
=======
        image_url: fullImageUrl,
        image: fullImageUrl,
>>>>>>> eaee52b12e147de79c7937b99b425177c5de381d
        vendor_name: service.vendor?.vendorProfile?.business_name || "Vendor",
        vendor_image: service.vendor?.vendorProfile?.image || null,
        // The booking screen resolves price-per-car from this — it needs the
        // FULL list, not just the cheapest, because the price must change as
        // the customer switches between saved vehicles.
        segment_prices: (service.segmentPrices ?? []).map((sp) => ({
          segment: sp.segment,
          price: parseFloat(sp.price.toString()),
        })),
      };
      res.json(enrichedService);
    } else {
      res.status(404).json({ message: "Service not found" });
    }
  } catch (error) {
    console.error("Error in getServiceById:", error);
    res.status(500).json({ message: "Server Error" });
  }
};

/**
 * Get Service Categories (Public)
 * Retrieves a list of unique service categories available in the system.
 *
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 */
export const getServiceCategories = async (req, res) => {
  try {
    const categories = await prisma.service.groupBy({
      by: ["category"],
    });
    const formatted = categories.map((c) => ({ name: c.category }));
    res.json(formatted);
  } catch (error) {
    console.error("Error in getServiceCategories:", error);
    res.status(500).json({ message: "Server Error" });
  }
};

<<<<<<< HEAD
// @desc    Get Featured Services (for user homepage)
// @route   GET /service_api/user/services/featured
export const getFeaturedServices = async (req, res) => {
  try {
    const { limit = 10 } = req.query;

    // Get online vendor IDs first
    const onlineVendors = await prisma.vendorProfile.findMany({
      where: { is_online: true },
      select: { userId: true }
    });
    const onlineVendorIds = onlineVendors.map(v => v.userId);

    const services = await prisma.service.findMany({
      where: {
        is_active: true,
        is_featured: true,
        vendorId: { in: onlineVendorIds } // Only show featured services from online vendors
      },
      take: Number(limit),
=======
/**
 * Get Featured Services (Public)
 * Retrieves services marked as featured, filtered by online status of vendors.
 *
 * @param {Object} req - Express request object
 * @param {Object} req.query - Query parameters
 * @param {number} [req.query.page=1] - Page number
 * @param {number} [req.query.limit=10] - Items per page
 * @param {Object} res - Express response object
 */
export const getFeaturedServices = async (req, res) => {
  try {
    const { latitude, longitude, online_only } = req.query;
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 10));
    const skip = (page - 1) * limit;

    const where = {
      is_active: true,
      is_featured: true,
      vendor: { vendorProfile: { is_online: true } }
    };

    // Filter by online vendors if requested
    if (online_only === 'true') {
      const onlineVendors = await prisma.vendorProfile.findMany({
        where: { is_online: true },
        select: { userId: true }
      });
      const vendorIds = onlineVendors.map(v => v.userId);
      where.vendorId = { in: vendorIds };
    }

    // Get all services with vendor profile info
    const services = await prisma.service.findMany({
      where,
      skip,
      take: limit,
>>>>>>> eaee52b12e147de79c7937b99b425177c5de381d
      include: { vendor: { include: { vendorProfile: true } } },
      orderBy: { id: "desc" },
    });

<<<<<<< HEAD
    const enrichedServices = services.map((service) => ({
      ...service,
      image_url: service.image_url
        ? `${req.protocol}://${req.get("host")}${service.image_url}`
        : null,
      image: service.image_url
        ? `${req.protocol}://${req.get("host")}${service.image_url}`
        : null,
      vendor_name: service.vendor?.vendorProfile?.business_name || "Vendor",
      vendor_image: service.vendor?.vendorProfile?.image || null,
      cover_image: service.vendor?.vendorProfile?.cover_image || null,
    }));

    res.json(enrichedServices);
  } catch (error) {
    console.error(error);
=======
    const total = await prisma.service.count({ where });

    const enrichedServices = services.map((service) => {
      const imgUrl = service.image_url;
      const fullImageUrl = imgUrl
        ? imgUrl.startsWith("http")
          ? imgUrl
          : `${req.protocol}://${req.get("host")}${imgUrl.startsWith('/') ? '' : '/'}${imgUrl}`
        : null;

      // Calculate distance if user location and vendor location are available
      let distance = null;
      let distanceText = null;
      if (latitude && longitude && service.vendor?.vendorProfile?.latitude && service.vendor?.vendorProfile?.longitude) {
        const lat1 = parseFloat(latitude);
        const lon1 = parseFloat(longitude);
        const lat2 = parseFloat(service.vendor.vendorProfile.latitude);
        const lon2 = parseFloat(service.vendor.vendorProfile.longitude);

        const R = 6371; // Earth's radius in kilometers
        const dLat = (lat2 - lat1) * (Math.PI / 180);
        const dLon = (lon2 - lon1) * (Math.PI / 180);
        const a =
          Math.sin(dLat / 2) * Math.sin(dLat / 2) +
          Math.cos(lat1 * (Math.PI / 180)) *
            Math.cos(lat2 * (Math.PI / 180)) *
            Math.sin(dLon / 2) *
            Math.sin(dLon / 2);
        const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
        distance = R * c;

        // Format distance text
        distanceText = distance < 1
          ? `${Math.round(distance * 1000)}m away`
          : `${distance.toFixed(1)}km away`;
      }

      return {
        ...service,
        image_url: fullImageUrl,
        image: fullImageUrl,
        vendor_name: service.vendor?.vendorProfile?.business_name || "Vendor",
        vendor_image: service.vendor?.vendorProfile?.image || null,
        cover_image: service.vendor?.vendorProfile?.cover_image || null,
        distance,
        distanceText,
        vendor_address: service.vendor?.vendorProfile?.address || null,
        vendor_city: service.vendor?.vendorProfile?.city || null,
      };
    });

    res.json({
      data: enrichedServices,
      pagination: {
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit) || 1,
      },
    });
  } catch (error) {
    console.error("Error in getFeaturedServices:", error);
>>>>>>> eaee52b12e147de79c7937b99b425177c5de381d
    res.status(500).json({ message: "Server Error" });
  }
};

<<<<<<< HEAD
// @desc    Search Vendors by Location (Haversine)
// @route   GET /service_api/search/vendors/location/
=======
/**
 * Search Vendors by Location (Public)
 * Finds vendors within a specific radius of a given location using database-level spatial logic.
 *
 * @param {Object} req - Express request object
 * @param {Object} req.query - Query parameters
 * @param {number} req.query.latitude - User latitude
 * @param {number} req.query.longitude - User longitude
 * @param {number} [req.query.radius=10] - Search radius in kilometers
 * @param {Object} res - Express response object
 */
>>>>>>> eaee52b12e147de79c7937b99b425177c5de381d
export const searchVendorsByLocation = async (req, res) => {
  const { latitude, longitude, radius = 10 } = req.query;

  if (!latitude || !longitude) {
    return res
      .status(400)
      .json({ error: "Invalid or missing latitude/longitude" });
  }

  try {
<<<<<<< HEAD
    const vendors = await prisma.vendorProfile.findMany({
      where: {
        status: "approved",
        is_online: true, // Only show online vendors
        latitude: { not: null },
        longitude: { not: null },
      },
      include: { user: true },
    });
=======
    const userLat = parseFloat(latitude);
    const userLon = parseFloat(longitude);
    const searchRadius = parseFloat(radius);
>>>>>>> eaee52b12e147de79c7937b99b425177c5de381d

    // Database level distance calculation
    const distanceSql = Prisma.sql`
      (6371 * acos(
        LEAST(1, GREATEST(-1, 
          cos(radians(${userLat})) * cos(radians(latitude)) * 
          cos(radians(longitude) - radians(${userLon})) + 
          sin(radians(${userLat})) * sin(radians(latitude))
        ))
      ))
    `;

    const nearbyVendors = await prisma.$queryRaw`
      SELECT *, ${distanceSql} as distance
      FROM "VendorProfile"
      WHERE status = 'approved' 
        AND is_online = true
        AND latitude IS NOT NULL 
        AND longitude IS NOT NULL
        AND ${distanceSql} <= ${searchRadius}
      ORDER BY distance ASC
    `;

    const vendorIds = nearbyVendors.map((v) => v.userId);
    const services = await prisma.service.findMany({
      where: { vendorId: { in: vendorIds }, is_active: true },
    });

    const formattedVendors = nearbyVendors.map((v) => ({
      id: v.userId,
      business_name: v.business_name,
      address: v.address,
      latitude: v.latitude,
      longitude: v.longitude,
      distance: parseFloat(v.distance),
      service_area_radius: 10, // Default or from profile
    }));

    res.json({
      vendors: formattedVendors,
      services: services,
    });
  } catch (error) {
    console.error("Error in searchVendorsByLocation:", error);
    res.status(500).json({ message: "Server Error" });
  }
};

<<<<<<< HEAD
// @desc    Get Services by Vendor ID (Public)
// @route   GET /service_api/user/vendors/:vendorId/services
=======
/**
 * Get Services by Vendor (Public)
 * Retrieves all active services for a specific vendor.
 *
 * @param {Object} req - Express request object
 * @param {Object} req.params - URL parameters
 * @param {number} req.params.vendorId - Vendor's user ID
 * @param {Object} res - Express response object
 */
>>>>>>> eaee52b12e147de79c7937b99b425177c5de381d
export const getServicesByVendor = async (req, res) => {
  try {
    const { vendorId } = req.params;

<<<<<<< HEAD
    // Check if vendor exists first? Optional but good.
    // The link is via vendorId (Int) -> Service.vendorId (Int)
    // Note: In schema, Service.vendorId refers to userId of the vendor.
    // Ensure the frontend passes the correct ID (User ID of the vendor).

    const services = await prisma.service.findMany({
      where: { vendorId: parseInt(vendorId), is_active: true },
      include: { vendor: { include: { vendorProfile: true } } },
      orderBy: { id: "desc" },
    });

    const enrichedServices = services.map((service) => ({
      ...service,
      image_url: service.image_url
        ? service.image_url.startsWith("http")
          ? service.image_url
          : `${req.protocol}://${req.get("host")}${service.image_url}`
        : null,
      image: service.image_url
        ? service.image_url.startsWith("http")
          ? service.image_url
          : `${req.protocol}://${req.get("host")}${service.image_url}`
        : null,
      vendor_name: service.vendor?.vendorProfile?.business_name || "Vendor",
      vendor_image: service.vendor?.vendorProfile?.image || null,
      vendor_cover_image: service.vendor?.vendorProfile?.cover_image || null,
      cover_image: service.vendor?.vendorProfile?.cover_image || null,
    }));

    res.json(enrichedServices);
  } catch (error) {
    console.error(error);
=======
    // The link is via vendorId (Int) -> Service.vendorId (Int).
    // Note: In schema, Service.vendorId refers to userId of the vendor.
    const { page = 1, limit = 50 } = req.query;
    const skip = (page - 1) * limit;

    const services = await prisma.service.findMany({
      where: { vendorId: parseInt(vendorId), is_active: true },
      include: { vendor: { include: { vendorProfile: true } }, segmentPrices: true },
      orderBy: { id: "desc" },
      skip: Number(skip),
      take: Number(limit),
    });

    const enrichedServices = services.map((service) => {
      const imgUrl = service.image_url;
      const fullImageUrl = imgUrl
        ? imgUrl.startsWith("http")
          ? imgUrl
          : `${req.protocol}://${req.get("host")}${imgUrl.startsWith('/') ? '' : '/'}${imgUrl}`
        : null;

      return {
        ...service,
        image_url: fullImageUrl,
        image: fullImageUrl,
        vendor_name: service.vendor?.vendorProfile?.business_name || "Vendor",
        vendor_image: service.vendor?.vendorProfile?.image || null,
        vendor_cover_image: service.vendor?.vendorProfile?.cover_image || null,
        cover_image: service.vendor?.vendorProfile?.cover_image || null,
        // segmentPrices (Prisma relation, camelCase) was included above but
        // never mapped to segment_prices here, unlike getServiceById and the
        // other list endpoint — so the vendor-profile screen's service cards
        // could never show the segment/car-name info the vendor set, even
        // though it was already being fetched from the DB.
        segment_prices: (service.segmentPrices ?? []).map((sp) => ({
          segment: sp.segment,
          price: parseFloat(sp.price.toString()),
        })),
      };
    });

    res.json(enrichedServices);
  } catch (error) {
    console.error("Error in getServicesByVendor:", error);
>>>>>>> eaee52b12e147de79c7937b99b425177c5de381d
    res.status(500).json({ message: "Server Error" });
  }
};




<<<<<<< HEAD
=======

>>>>>>> eaee52b12e147de79c7937b99b425177c5de381d
