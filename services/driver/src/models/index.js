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
  drivers: {
    validator: {
      $jsonSchema: {
        bsonType: 'object',
        required: [
          '_id',
          'driverId',
          'userId',
          'registrationId',
          'approvalStatus',
          'availabilityStatus',
          'licenseCiphertext',
          'vehicle',
        ],
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
      [
        {
          licenseFingerprint: 1,
        },
        {
          unique: true,
        },
      ],
      [
        {
          'vehicle.plateNumber': 1,
        },
        {
          unique: true,
        },
      ],
      [
        {
          position: '2dsphere',
        },
        {},
      ],
    ],
  },
  samples: {
    validator: {
      $jsonSchema: {
        bsonType: 'object',
        required: ['_id', 'requestHash', 'result'],
        properties: {
          _id: {
            bsonType: 'string',
          },
        },
      },
    },
    indexes: [],
  },
  released: {
    validator: {
      $jsonSchema: {
        bsonType: 'object',
        required: ['_id', 'assignmentId', 'tripId'],
        properties: {
          _id: {
            bsonType: 'string',
          },
        },
      },
    },
    indexes: [],
  },
};
