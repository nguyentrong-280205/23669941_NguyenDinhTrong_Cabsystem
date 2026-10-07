// MongoDB owner schema/index definitions. Requires a replica set for transactions.
module.exports = {
  runtime: {
    validator: {
      $jsonSchema: {
        bsonType: 'object',
        required: ['_id'],
        properties: {
          _id: {
            bsonType: 'string',
          },
        },
      },
    },
    indexes: [],
  },
  outbox: {
    validator: {
      $jsonSchema: {
        bsonType: 'object',
        required: ['_id'],
        properties: {
          _id: {
            bsonType: 'string',
          },
        },
      },
    },
    indexes: [],
  },
  inbox: {
    validator: {
      $jsonSchema: {
        bsonType: 'object',
        required: ['_id'],
        properties: {
          _id: {
            bsonType: 'string',
          },
        },
      },
    },
    indexes: [],
  },
  audit: {
    validator: {
      $jsonSchema: {
        bsonType: 'object',
        required: ['_id'],
        properties: {
          _id: {
            bsonType: 'string',
          },
        },
      },
    },
    indexes: [],
  },
  operations: {
    validator: {
      $jsonSchema: {
        bsonType: 'object',
        required: ['_id'],
        properties: {
          _id: {
            bsonType: 'string',
          },
        },
      },
    },
    indexes: [],
  },
  notifications: {
    validator: {
      $jsonSchema: {
        bsonType: 'object',
        required: ['_id', 'notificationId', 'recipientId', 'userId', 'content', 'status'],
        properties: {
          _id: {
            bsonType: 'string',
          },
        },
      },
    },
    indexes: [
      [
        {
          notificationId: 1,
        },
        {
          unique: true,
        },
      ],
      [
        {
          recipientId: 1,
          createdAt: -1,
        },
        {},
      ],
    ],
  },
  deliveries: {
    validator: {
      $jsonSchema: {
        bsonType: 'object',
        required: ['_id', 'notificationId', 'status', 'attempts', 'nextAt'],
        properties: {
          _id: {
            bsonType: 'string',
          },
        },
      },
    },
    indexes: [
      [
        {
          notificationId: 1,
        },
        {
          unique: true,
        },
      ],
      [
        {
          status: 1,
          nextAt: 1,
        },
        {},
      ],
    ],
  },
};
