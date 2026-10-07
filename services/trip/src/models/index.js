module.exports = {
  locationSamples: {
    validator: { $jsonSchema: { bsonType: 'object', required: ['_id', 'sampleId', 'tripId'] } },
    indexes: [],
  },
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
  trips: {
    validator: {
      $jsonSchema: {
        bsonType: 'object',
        required: [
          '_id',
          'tripId',
          'bookingId',
          'assignmentId',
          'customerId',
          'driverId',
          'status',
          'activated',
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
          bookingId: 1,
        },
        {
          unique: true,
        },
      ],
      [
        {
          assignmentId: 1,
        },
        {
          unique: true,
        },
      ],
    ],
  },
  ratings: {
    validator: {
      $jsonSchema: {
        bsonType: 'object',
        required: ['_id', 'tripId', 'ratingId', 'customerId', 'score'],
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
          tripId: 1,
        },
        {
          unique: true,
        },
      ],
    ],
  },
  pricing: {
    validator: {
      $jsonSchema: {
        bsonType: 'object',
        required: [
          '_id',
          'pricingRuleId',
          'vehicleTypeId',
          'effectiveFrom',
          'baseFare',
          'perKmRate',
          'perMinuteRate',
          'version',
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
          pricingRuleId: 1,
        },
        {
          unique: true,
        },
      ],
    ],
  },
  tombstones: {
    validator: {
      $jsonSchema: {
        bsonType: 'object',
        required: ['_id', 'assignmentId', 'operationId'],
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
