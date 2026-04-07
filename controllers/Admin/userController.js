import prisma from '../../util/prisma.js';

export const getUsersData = async (req,res) => {
  try {
    const last30Days = new Date();
    last30Days.setData(last30Days.getData() - 30);

    const [ totalUser, activeUserLast30Days, newUsersLast30Days] = await Promise.all([

      //total users
      prisma.user.count({
        where:{
          role: "user"
        }
      }),

      // total active users in last 30 days
      prisma.user.count({
        where:{
          role: "user",
          is_active: true,
          createdAt:{
            gte: last30Days
          }
        }
      }),

      // new users in last 30 days

      prisma.user.count({
        where:{
          role: "user",
          createdAt:{
            gte:last30Days
          }
        }
      })
    ])

    res.json({
      totalUser,
      activeUserLast30Days,
      newUsersLast30Days
    })
    
  } catch (error) {
    console.error(error);
    res.status(500).json({message: "Failed to fetch users data"})
    
  }
}