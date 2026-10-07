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
  customers: {
    validator: {
      $jsonSchema: {
        bsonType: 'object',
        required: ['_id', 'customerId', 'userId', 'registrationId'],
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
          userId: 1,
        },
        {
          unique: true,
        },
      ],
      [
        {
          registrationId: 1,
        },
        {
          unique: true,
        },
      ],
    ],
  },
  changes: {
    validator: {
      $jsonSchema: {
        bsonType: 'object',
        required: ['_id', 'key', 'customerId', 'status'],
      },
    },
    indexes: [
      [
        {
          status: 1,
        },
        {},
      ],
    ],
  },
};
