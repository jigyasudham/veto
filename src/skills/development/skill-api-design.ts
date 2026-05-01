// Skill: api-design — REST API design guide with OpenAPI 3.0 skeleton

export interface SkillInput {
  task: string;
  context?: string;
  options?: Record<string, unknown>;
}

export interface SkillOutput {
  skill: string;
  template?: string;
  checklist: string[];
  patterns: string[];
  gotchas: string[];
  resources: string[];
}

const TEMPLATE = `
openapi: 3.0.3
info:
  title: My API
  description: >
    RESTful API for My Application.
    All endpoints require a Bearer token unless marked as public.
  version: 1.0.0
  contact:
    name: API Support
    email: api@example.com

servers:
  - url: https://api.example.com/v1
    description: Production
  - url: http://localhost:3000/v1
    description: Local development

security:
  - BearerAuth: []

# ── Components ─────────────────────────────────────────────────────────────
components:
  securitySchemes:
    BearerAuth:
      type: http
      scheme: bearer
      bearerFormat: JWT

  schemas:
    # Pagination wrapper
    PaginatedResponse:
      type: object
      required: [data, meta]
      properties:
        data:
          type: array
          items: {}
        meta:
          type: object
          required: [total, page, pageSize, totalPages]
          properties:
            total:       { type: integer, example: 142 }
            page:        { type: integer, example: 1 }
            pageSize:    { type: integer, example: 20 }
            totalPages:  { type: integer, example: 8 }

    # Error envelope
    ErrorResponse:
      type: object
      required: [error]
      properties:
        error:
          type: object
          required: [code, message]
          properties:
            code:    { type: string,  example: VALIDATION_ERROR }
            message: { type: string,  example: "name must not be empty" }
            details: { type: array, items: { type: string } }

    # Resource example
    Item:
      type: object
      required: [id, name, userId, createdAt, updatedAt]
      properties:
        id:          { type: string, format: uuid }
        name:        { type: string, minLength: 1, maxLength: 100 }
        description: { type: string, maxLength: 500 }
        userId:      { type: string, format: uuid }
        createdAt:   { type: string, format: date-time }
        updatedAt:   { type: string, format: date-time }

    CreateItemRequest:
      type: object
      required: [name]
      properties:
        name:        { type: string, minLength: 1, maxLength: 100 }
        description: { type: string, maxLength: 500 }

    UpdateItemRequest:
      type: object
      minProperties: 1
      properties:
        name:        { type: string, minLength: 1, maxLength: 100 }
        description: { type: string, maxLength: 500 }

  parameters:
    ItemId:
      name: id
      in: path
      required: true
      schema: { type: string, format: uuid }
    PageParam:
      name: page
      in: query
      schema: { type: integer, minimum: 1, default: 1 }
    PageSizeParam:
      name: pageSize
      in: query
      schema: { type: integer, minimum: 1, maximum: 100, default: 20 }
    SortParam:
      name: sort
      in: query
      schema: { type: string, enum: [createdAt, updatedAt, name], default: createdAt }
    OrderParam:
      name: order
      in: query
      schema: { type: string, enum: [asc, desc], default: desc }

  responses:
    Unauthorized:
      description: Missing or invalid authentication token
      content:
        application/json:
          schema: { $ref: '#/components/schemas/ErrorResponse' }
    Forbidden:
      description: Authenticated but not authorised to access this resource
      content:
        application/json:
          schema: { $ref: '#/components/schemas/ErrorResponse' }
    NotFound:
      description: Resource not found
      content:
        application/json:
          schema: { $ref: '#/components/schemas/ErrorResponse' }
    UnprocessableEntity:
      description: Validation error in request body
      content:
        application/json:
          schema: { $ref: '#/components/schemas/ErrorResponse' }
    TooManyRequests:
      description: Rate limit exceeded
      headers:
        Retry-After: { schema: { type: integer } }
      content:
        application/json:
          schema: { $ref: '#/components/schemas/ErrorResponse' }

# ── Paths ──────────────────────────────────────────────────────────────────
paths:
  /items:
    get:
      operationId: listItems
      summary: List items belonging to the authenticated user
      tags: [Items]
      parameters:
        - $ref: '#/components/parameters/PageParam'
        - $ref: '#/components/parameters/PageSizeParam'
        - $ref: '#/components/parameters/SortParam'
        - $ref: '#/components/parameters/OrderParam'
      responses:
        '200':
          description: Paginated list of items
          content:
            application/json:
              schema:
                allOf:
                  - $ref: '#/components/schemas/PaginatedResponse'
                  - properties:
                      data:
                        type: array
                        items: { $ref: '#/components/schemas/Item' }
        '401': { $ref: '#/components/responses/Unauthorized' }
        '429': { $ref: '#/components/responses/TooManyRequests' }

    post:
      operationId: createItem
      summary: Create a new item
      tags: [Items]
      requestBody:
        required: true
        content:
          application/json:
            schema: { $ref: '#/components/schemas/CreateItemRequest' }
      responses:
        '201':
          description: Item created
          headers:
            Location: { schema: { type: string }, description: URL of the created item }
          content:
            application/json:
              schema:
                type: object
                properties:
                  data: { $ref: '#/components/schemas/Item' }
        '401': { $ref: '#/components/responses/Unauthorized' }
        '422': { $ref: '#/components/responses/UnprocessableEntity' }

  /items/{id}:
    parameters:
      - $ref: '#/components/parameters/ItemId'

    get:
      operationId: getItem
      summary: Get a single item by ID
      tags: [Items]
      responses:
        '200':
          description: Item found
          content:
            application/json:
              schema:
                type: object
                properties:
                  data: { $ref: '#/components/schemas/Item' }
        '401': { $ref: '#/components/responses/Unauthorized' }
        '403': { $ref: '#/components/responses/Forbidden' }
        '404': { $ref: '#/components/responses/NotFound' }

    patch:
      operationId: updateItem
      summary: Partially update an item (only provided fields are changed)
      tags: [Items]
      requestBody:
        required: true
        content:
          application/json:
            schema: { $ref: '#/components/schemas/UpdateItemRequest' }
      responses:
        '200':
          description: Item updated
          content:
            application/json:
              schema:
                type: object
                properties:
                  data: { $ref: '#/components/schemas/Item' }
        '401': { $ref: '#/components/responses/Unauthorized' }
        '403': { $ref: '#/components/responses/Forbidden' }
        '404': { $ref: '#/components/responses/NotFound' }
        '422': { $ref: '#/components/responses/UnprocessableEntity' }

    delete:
      operationId: deleteItem
      summary: Delete an item
      tags: [Items]
      responses:
        '204':
          description: Item deleted — no content returned
        '401': { $ref: '#/components/responses/Unauthorized' }
        '403': { $ref: '#/components/responses/Forbidden' }
        '404': { $ref: '#/components/responses/NotFound' }

  /health:
    get:
      operationId: getHealth
      summary: Health check — no authentication required
      tags: [System]
      security: []
      responses:
        '200':
          description: Service is healthy
          content:
            application/json:
              schema:
                type: object
                properties:
                  status: { type: string, example: ok }
                  uptime: { type: number, example: 12345.6 }
`.trim();

export function run(input: SkillInput): SkillOutput {
  return {
    skill: 'api-design',
    template: TEMPLATE,
    checklist: [
      'Choose a consistent resource naming convention: plural nouns, kebab-case (e.g., /user-profiles)',
      'Version the API in the URL path: /v1/resource (not Accept header for most APIs)',
      'Use correct HTTP methods: GET (read), POST (create), PUT (replace), PATCH (partial update), DELETE (remove)',
      'Use correct HTTP status codes: 200 OK, 201 Created, 204 No Content, 400 Bad Request, 401 Unauthorized, 403 Forbidden, 404 Not Found, 409 Conflict, 422 Unprocessable Entity, 429 Too Many Requests, 500 Internal Server Error',
      'Always return a consistent error envelope: { error: { code, message, details? } }',
      'Wrap list responses in { data: [], meta: { total, page, pageSize, totalPages } }',
      'Add Location header on 201 Created pointing to the new resource URL',
      'Implement cursor-based pagination for large, frequently-updated datasets',
      'Support filtering via query parameters: ?status=active&userId=xxx',
      'Support sorting via ?sort=createdAt&order=desc',
      'Set authentication via Authorization: Bearer <token> header (not query param)',
      'Define all schemas in OpenAPI components/schemas and $ref them — no inline duplication',
      'Document every response code, including error responses, in the OpenAPI spec',
      'Apply rate limiting headers: X-RateLimit-Limit, X-RateLimit-Remaining, X-RateLimit-Reset',
      'Set security headers: CORS, Content-Type: application/json, X-Content-Type-Options: nosniff',
      'Use idempotency keys for POST endpoints that create resources (Idempotency-Key header)',
      'Do not nest resources more than 2 levels deep: /users/{id}/items, not /users/{id}/orders/{id}/items/{id}/tags',
      'Return 204 with no body for successful DELETE, not 200 with empty object',
      'Use ISO 8601 for all date/time fields: "2024-01-15T10:30:00Z"',
      'Generate an SDK or client library from the OpenAPI spec using openapi-generator',
    ],
    patterns: [
      'Resource-oriented design: endpoints represent nouns, HTTP methods are the verbs',
      'Envelope pattern: { data: T, meta: M } for lists; { data: T } for single resources',
      'Error code + message pattern: machine-readable code + human-readable message',
      'Consistent pagination: cursor-based for feeds, offset/page for admin views',
      'OpenAPI-first design: write the spec before implementing, validate implementation against it',
    ],
    gotchas: [
      'Using GET with a request body for search — use POST /resource/search or query params instead',
      'Returning 200 with { success: false } — use the correct status code, not always 200',
      'Inconsistent pluralisation: /user vs /users — pick one convention and apply everywhere',
      'Exposing internal IDs (auto-increment integers) — use UUIDs to prevent IDOR and enumeration',
      'Not documenting rate limits in the spec — clients cannot implement retry logic without this',
      'CORS misconfiguration: wildcard origin with credentials:true is invalid and silently ignored by browsers',
      'Changing URL structure or removing fields without a deprecation period — breaks existing clients',
    ],
    resources: [
      'https://spec.openapis.org/oas/v3.0.3',
      'https://cloud.google.com/apis/design',
      'https://cheatsheetseries.owasp.org/cheatsheets/REST_Security_Cheat_Sheet.html',
      'https://restfulapi.net/',
      'https://www.rfc-editor.org/rfc/rfc9457 (Problem Details for HTTP APIs)',
    ],
  };
}
