import type {
  InferArgs,
  InferValue,
  ParameterSchemaSpec,
  ValueSchemaSpec,
} from '@deepseek-ai/dsh-tools'

import {
  DOCS_SEARCH_DEFAULT_MAX_RESULTS,
  DOCS_SEARCH_MAX_RESULTS_LIMIT,
  SEARCH_DEPTHS,
  SEARCH_PROFILES,
  SITE_MAP_DEFAULT_LIMIT,
  SITE_MAP_DEFAULT_MAX_BREADTH,
  SITE_MAP_DEFAULT_MAX_DEPTH,
  SITE_MAP_MAX_DEPTH,
} from '../config.js'
import {
  DOCUMENTATION_CACHE_PATH_STATES,
  DOCUMENTATION_CACHE_SKIP_REASONS,
  DOCUMENTATION_PROVIDER_STATES,
  DOCUMENTATION_RESULT_PROVIDERS,
  DOCUMENTATION_SEARCH_PROVIDERS,
  DOCUMENTATION_WARNING_CODES,
} from '../documentation/index.js'
import { SOURCE_CATEGORIES } from '../contracts/index.js'
import { SEARCH_WARNING_CODES } from '../orchestration/index.js'
import {
  PROVIDER_CAPABILITIES,
  PROVIDER_ERROR_KINDS,
} from '../provider-runtime/index.js'
import {
  DIRECT_CONTENT_TRANSFORMS,
  DIRECT_METADATA_ONLY_REASONS,
  WEB_EXTRACT_EVIDENCE_LEVELS,
  WEB_EXTRACT_FORMATS,
  WEB_EXTRACT_ROUTES,
} from '../web-extract/types.js'
import { SITE_MAP_WARNING_CODES } from '../site-map/index.js'
import { SOURCE_PAGE_FORMATS } from '../source-storage/index.js'

export const VISIBLE_SOURCE_SCHEMA = {
  type: 'object',
  properties: {
    url: {
      type: 'string',
      required: true,
      description: 'HTTP(S) source URL.',
    },
    title: {
      type: 'string',
      description: 'Source title when supplied by a search Provider.',
    },
    snippet: {
      type: 'string',
      description: 'Discovery snippet; not fetched page-body evidence.',
    },
    publishedAt: {
      type: 'string',
      description: 'Provider-supplied publication or crawl timestamp.',
    },
  },
  additionalProperties: false,
} as const satisfies ValueSchemaSpec

const searchWarningSchema = {
  type: 'object',
  properties: {
    code: {
      type: 'string',
      enum: SEARCH_WARNING_CODES,
      required: true,
      description: 'Stable warning category.',
    },
    capability: {
      type: 'string',
      enum: PROVIDER_CAPABILITIES,
      description: 'Affected search capability, when applicable.',
    },
    provider: {
      type: 'string',
      description: 'Credential-free Provider identifier, when applicable.',
    },
    error_kind: {
      type: 'string',
      enum: PROVIDER_ERROR_KINDS,
      description: 'Safe Provider failure category, when applicable.',
    },
  },
  additionalProperties: false,
} as const satisfies ValueSchemaSpec

/** The complete model-visible argument surface for `web_search`. */
export const WEB_SEARCH_PARAMETERS = {
  query: {
    type: 'string',
    required: true,
    description: 'A non-empty, self-contained natural-language search question.',
  },
  profile: {
    type: 'string',
    enum: SEARCH_PROFILES,
    description: 'Optional search strategy; omitted uses the user setting.',
  },
  depth: {
    type: 'string',
    enum: SEARCH_DEPTHS,
    description: 'Optional result depth; omitted uses the user setting.',
  },
} as const satisfies ParameterSchemaSpec

/**
 * Canonical search value shared by Native Tool Mode and Code Mode.
 * `model_text_max_bytes` is a replayable product field: DSH's pure renderer
 * otherwise cannot recover the operation's Settings-selected byte ceiling.
 */
export const WEB_SEARCH_OUTPUT_SCHEMA = {
  type: 'object',
  properties: {
    state: {
      type: 'string',
      enum: ['complete', 'partial'],
      required: true,
    },
    answer: { type: 'string' },
    sources: {
      type: 'array',
      items: VISIBLE_SOURCE_SCHEMA,
      required: true,
    },
    source_ref: {
      type: 'string',
      description: 'Opaque private-storage reference for search_sources.',
    },
    total_sources: {
      type: 'integer',
      required: true,
    },
    returned_sources: {
      type: 'integer',
      required: true,
    },
    truncated: {
      type: 'boolean',
      required: true,
    },
    evidence_level: {
      type: 'string',
      const: 'discovery',
      required: true,
    },
    warnings: {
      type: 'array',
      items: searchWarningSchema,
      required: true,
    },
    model_text_max_bytes: {
      type: 'integer',
      required: true,
      description: 'Applied UTF-8 ceiling for the Native model-text projection.',
    },
  },
  additionalProperties: false,
} as const satisfies ValueSchemaSpec

export const DOCS_SEARCH_MAX_RESULTS_VALUES = [
  1, 2, 3, 4, 5, 6, 7, 8, 9, 10,
  11, 12, 13, 14, 15, 16, 17, 18, 19, 20,
] as const

if (DOCS_SEARCH_MAX_RESULTS_VALUES.at(-1) !== DOCS_SEARCH_MAX_RESULTS_LIMIT) {
  throw new Error('docs_search schema and Settings result limits drifted')
}

/** The complete model-visible task-intent surface for high-level documentation search. */
export const DOCS_SEARCH_PARAMETERS = {
  query: {
    type: 'string',
    required: true,
    description: 'A non-empty SDK, API, framework, README, release, or documentation question.',
  },
  provider: {
    type: 'string',
    enum: DOCUMENTATION_SEARCH_PROVIDERS,
    description: 'auto (default), Context7, Exa, or both. Without a Context7 library identity, auto is Exa-only.',
  },
  library_name: {
    type: 'string',
    description: 'Optional Context7 package or product name, such as React or FastAPI. Required for Context7 resolve when library_id is absent; never sent to Exa.',
  },
  library_id: {
    type: 'string',
    description: 'Optional exact Context7 /org/project or /org/project/version id; takes priority over library_name and strictly skips resolve.',
  },
  max_results: {
    type: 'integer',
    enum: DOCS_SEARCH_MAX_RESULTS_VALUES,
    default: DOCS_SEARCH_DEFAULT_MAX_RESULTS,
    description: 'Maximum results (1-20); defaults to 6 and may be lowered by Settings.',
  },
  force_refresh: {
    type: 'boolean',
    description: 'Bypass fresh Context7 cache entries and request current Provider data.',
  },
} as const satisfies ParameterSchemaSpec

const docsSnippetSchema = {
  type: 'object',
  properties: {
    content: {
      type: 'string',
      required: true,
      description: 'Bounded Context7 documentation snippet; discovery metadata, not a fetched page body.',
    },
    title: { type: 'string' },
    library_id: { type: 'string' },
  },
  additionalProperties: false,
} as const satisfies ValueSchemaSpec

const selectedLibrarySchema = {
  type: 'object',
  properties: {
    id: { type: 'string', required: true },
    title: { type: 'string' },
    description: { type: 'string' },
  },
  additionalProperties: false,
} as const satisfies ValueSchemaSpec

const documentationProviderStatusSchema = {
  type: 'object',
  properties: {
    provider: {
      type: 'string',
      enum: DOCUMENTATION_RESULT_PROVIDERS,
      required: true,
    },
    state: {
      type: 'string',
      enum: DOCUMENTATION_PROVIDER_STATES,
      required: true,
    },
  },
  additionalProperties: false,
} as const satisfies ValueSchemaSpec

const documentationCachePathSchema = {
  type: 'object',
  properties: {
    state: {
      type: 'string',
      enum: DOCUMENTATION_CACHE_PATH_STATES,
      required: true,
    },
    evicted_entries: { type: 'integer', required: true },
    reason: { type: 'string', enum: DOCUMENTATION_CACHE_SKIP_REASONS },
  },
  additionalProperties: false,
} as const satisfies ValueSchemaSpec

const documentationCacheSchema = {
  type: 'object',
  properties: {
    resolve: { ...documentationCachePathSchema, required: true },
    docs: { ...documentationCachePathSchema, required: true },
  },
  additionalProperties: false,
} as const satisfies ValueSchemaSpec

export const DOCS_SEARCH_WARNING_CODES = [
  ...DOCUMENTATION_WARNING_CODES,
  'sources_truncated',
  'canonical_output_truncated',
] as const

const docsSearchWarningSchema = {
  type: 'object',
  properties: {
    code: {
      type: 'string',
      enum: DOCS_SEARCH_WARNING_CODES,
      required: true,
    },
    provider: {
      type: 'string',
      enum: ['context7', 'exa', 'context7-cache'] as const,
    },
    path: { type: 'string', enum: ['resolve', 'docs'] as const },
    error_kind: { type: 'string', enum: PROVIDER_ERROR_KINDS },
    count: { type: 'integer' },
  },
  additionalProperties: false,
} as const satisfies ValueSchemaSpec

/** Canonical high-level documentation value shared exactly by Native and Code Mode. */
export const DOCS_SEARCH_OUTPUT_SCHEMA = {
  type: 'object',
  properties: {
    state: {
      type: 'string',
      enum: ['complete', 'partial'] as const,
      required: true,
    },
    provider: {
      type: 'string',
      enum: DOCUMENTATION_SEARCH_PROVIDERS,
      required: true,
    },
    providers: {
      type: 'array',
      items: documentationProviderStatusSchema,
      required: true,
    },
    selected_library: selectedLibrarySchema,
    snippets: {
      type: 'array',
      items: docsSnippetSchema,
      required: true,
    },
    sources: {
      type: 'array',
      items: VISIBLE_SOURCE_SCHEMA,
      required: true,
    },
    source_ref: {
      type: 'string',
      description: 'Opaque private-storage reference for search_sources.',
    },
    doc_ref: {
      type: 'string',
      description: 'Opaque, evictable reference to the plugin-private Context7 docs cache.',
    },
    cache: { ...documentationCacheSchema, required: true },
    total_sources: { type: 'integer', required: true },
    returned_sources: { type: 'integer', required: true },
    total_snippets: { type: 'integer', required: true },
    returned_snippets: { type: 'integer', required: true },
    truncated: { type: 'boolean', required: true },
    evidence_level: { type: 'string', const: 'discovery', required: true },
    warnings: {
      type: 'array',
      items: docsSearchWarningSchema,
      required: true,
    },
    model_text_max_bytes: {
      type: 'integer',
      required: true,
      description: 'Applied UTF-8 ceiling for the Native model-text projection.',
    },
  },
  additionalProperties: false,
} as const satisfies ValueSchemaSpec

const pageSourceSchema = {
  type: 'object',
  properties: {
    url: { type: 'string', required: true },
    title: { type: 'string' },
    date: { type: 'string' },
    category: {
      type: 'string',
      enum: SOURCE_CATEGORIES,
      required: true,
    },
    snippet: {
      type: 'string',
      description: 'Bounded discovery snippet; not fetched page-body evidence.',
    },
    snippet_truncated: { type: 'boolean', const: true },
  },
  additionalProperties: false,
} as const satisfies ValueSchemaSpec

/** The complete model-visible argument surface for `search_sources`. */
export const SEARCH_SOURCES_PARAMETERS = {
  source_ref: {
    type: 'string',
    required: true,
    description: 'Opaque source reference returned by web_search or docs_search.',
  },
  offset: {
    type: 'integer',
    description: 'Zero-based source offset; defaults to 0.',
  },
  limit: {
    type: 'integer',
    description: 'Positive page size; defaults to 20 and is capped by Settings.',
  },
  format: {
    type: 'string',
    enum: SOURCE_PAGE_FORMATS,
    description: 'compact (default) or full with bounded snippets.',
  },
} as const satisfies ParameterSchemaSpec

const sourcePageFoundSchema = {
  type: 'object',
  properties: {
    state: { type: 'string', const: 'found', required: true },
    source_ref: { type: 'string', required: true },
    offset: { type: 'integer', required: true },
    limit: { type: 'integer', required: true },
    format: { type: 'string', enum: SOURCE_PAGE_FORMATS, required: true },
    total: { type: 'integer', required: true },
    returned: { type: 'integer', required: true },
    sources: { type: 'array', items: pageSourceSchema, required: true },
    has_more: { type: 'boolean', required: true },
    next_offset: { type: 'integer' },
    total_before_retention: { type: 'integer', required: true },
    truncated: { type: 'boolean', required: true },
    page_byte_limited: { type: 'boolean', required: true },
  },
  additionalProperties: false,
} as const satisfies ValueSchemaSpec

const sourcePageNotFoundSchema = {
  type: 'object',
  properties: {
    state: { type: 'string', const: 'not_found', required: true },
    code: { type: 'string', const: 'SOURCE_REF_NOT_FOUND', required: true },
  },
  additionalProperties: false,
} as const satisfies ValueSchemaSpec

/** Canonical source-page union; not-found is a successful domain result, not an empty page. */
export const SEARCH_SOURCES_OUTPUT_SCHEMA = {
  oneOf: [sourcePageFoundSchema, sourcePageNotFoundSchema],
} as const satisfies ValueSchemaSpec

export const WEB_EXTRACT_PARAMETERS = {
  url: {
    type: 'string',
    required: true,
    description: 'A non-empty concrete HTTP(S) URL to read.',
  },
  provider: {
    type: 'string',
    enum: WEB_EXTRACT_ROUTES,
    required: true,
    description: 'Choose exactly one Provider enabled in user settings. No automatic fallback.',
  },
  format: {
    type: 'string',
    enum: WEB_EXTRACT_FORMATS,
    default: 'markdown',
    description: 'Output format; defaults to markdown.',
  },
} as const satisfies ParameterSchemaSpec

const webExtractAttemptSchema = {
  type: 'object',
  properties: {
    route: { type: 'string', enum: WEB_EXTRACT_ROUTES, required: true },
    outcome: {
      type: 'string',
      enum: ['success', 'failed', 'aborted', 'skipped'] as const,
      required: true,
    },
    count: { type: 'integer', required: true },
    duration_ms: { type: 'integer', required: true },
    fallback: { type: 'boolean', required: true },
    error_kind: { type: 'string', enum: PROVIDER_ERROR_KINDS },
    http_status: { type: 'integer' },
    retryable: { type: 'boolean' },
    skip_reason: {
      type: 'string',
      enum: [
        'not_configured',
        'not_applicable',
        'budget_zero',
        'format_unsupported',
        'disabled',
      ] as const,
    },
  },
  additionalProperties: false,
} as const satisfies ValueSchemaSpec

/** Stable snake-case webpage body value shared exactly by Native and Code Mode. */
export const WEB_EXTRACT_OUTPUT_SCHEMA = {
  type: 'object',
  properties: {
    requested_url: { type: 'string', required: true },
    final_url: { type: 'string' },
    content: { type: 'string', required: true },
    format: { type: 'string', enum: WEB_EXTRACT_FORMATS, required: true },
    title: { type: 'string' },
    author: { type: 'string' },
    published_at: { type: 'string' },
    canonical_url: { type: 'string' },
    content_type: { type: 'string' },
    content_length: { type: 'integer' },
    content_disposition: { type: 'string' },
    content_encoding: { type: 'string' },
    status_code: { type: 'integer' },
    encoded_bytes: { type: 'integer' },
    decompressed_bytes: { type: 'integer' },
    metadata_only_reason: { type: 'string', enum: DIRECT_METADATA_ONLY_REASONS },
    content_transform: { type: 'string', enum: DIRECT_CONTENT_TRANSFORMS },
    encoded_body_truncated: { type: 'boolean', const: true },
    decompressed_body_truncated: { type: 'boolean', const: true },
    output_truncated: { type: 'boolean', const: true },
    metadata_truncated: { type: 'boolean', const: true },
    canonical_output_truncated: { type: 'boolean', const: true },
    retrieval_route: { type: 'string', enum: WEB_EXTRACT_ROUTES, required: true },
    evidence_level: {
      type: 'string',
      enum: WEB_EXTRACT_EVIDENCE_LEVELS,
      required: true,
    },
    truncated: { type: 'boolean', required: true },
    attempts: {
      type: 'array',
      items: webExtractAttemptSchema,
      required: true,
    },
    model_text_max_bytes: {
      type: 'integer',
      required: true,
      description: 'Applied UTF-8 ceiling for the Native model-text projection.',
    },
  },
  additionalProperties: false,
} as const satisfies ValueSchemaSpec

export type WebExtractArgs = InferArgs<typeof WEB_EXTRACT_PARAMETERS>
export type WebExtractOutput = InferValue<typeof WEB_EXTRACT_OUTPUT_SCHEMA>
export type WebExtractOutputAttempt = WebExtractOutput['attempts'][number]

export const WEB_MAP_MAX_DEPTH_VALUES = [1, 2, 3, 4, 5] as const

if (WEB_MAP_MAX_DEPTH_VALUES.at(-1) !== SITE_MAP_MAX_DEPTH) {
  throw new Error('web_map schema and Tavily Map depth limit drifted')
}

/** Model-visible site-discovery intent; every deployment/transport control stays in Config. */
export const WEB_MAP_PARAMETERS = {
  url: {
    type: 'string',
    required: true,
    description: 'Absolute HTTP(S) root URL to map through Tavily; userinfo is rejected.',
  },
  instructions: {
    type: 'string',
    description: 'Optional natural-language filter for the website crawl.',
  },
  max_depth: {
    type: 'integer',
    enum: WEB_MAP_MAX_DEPTH_VALUES,
    default: SITE_MAP_DEFAULT_MAX_DEPTH,
    description: 'Maximum traversal depth (1-5); defaults to 1.',
  },
  max_breadth: {
    type: 'integer',
    default: SITE_MAP_DEFAULT_MAX_BREADTH,
    description: 'Maximum links followed per level (1-500); defaults to 10 and must not exceed the deployment cap.',
  },
  limit: {
    type: 'integer',
    default: SITE_MAP_DEFAULT_LIMIT,
    description: 'Total links processed (1-500); defaults to 30 and must not exceed the deployment cap.',
  },
} as const satisfies ParameterSchemaSpec

const webMapAttemptSchema = {
  type: 'object',
  properties: {
    provider: { type: 'string', const: 'tavily', required: true },
    outcome: { type: 'string', const: 'success', required: true },
    count: { type: 'integer', required: true },
    duration_ms: { type: 'integer', required: true },
    fallback: { type: 'boolean', const: false, required: true },
  },
  additionalProperties: false,
} as const satisfies ValueSchemaSpec

const webMapWarningSchema = {
  type: 'object',
  properties: {
    code: {
      type: 'string',
      enum: SITE_MAP_WARNING_CODES,
      required: true,
    },
    count: { type: 'integer' },
  },
  additionalProperties: false,
} as const satisfies ValueSchemaSpec

/** Stable, closed snake-case site-discovery value shared exactly by Native and Code Mode. */
export const WEB_MAP_OUTPUT_SCHEMA = {
  type: 'object',
  properties: {
    requested_url: { type: 'string', required: true },
    base_url: { type: 'string' },
    results: { type: 'array', items: { type: 'string' }, required: true },
    total_results: { type: 'integer', required: true },
    returned_results: { type: 'integer', required: true },
    max_depth: { type: 'integer', required: true },
    max_breadth: { type: 'integer', required: true },
    limit: { type: 'integer', required: true },
    response_time: { type: 'number' },
    truncated: { type: 'boolean', required: true },
    evidence_level: { type: 'string', const: 'discovery', required: true },
    provider: { type: 'string', const: 'tavily', required: true },
    attempts: {
      type: 'array',
      items: webMapAttemptSchema,
      required: true,
    },
    warnings: {
      type: 'array',
      items: webMapWarningSchema,
      required: true,
    },
    model_text_max_bytes: {
      type: 'integer',
      required: true,
      description: 'Applied UTF-8 ceiling for the Native model-text projection.',
    },
  },
  additionalProperties: false,
} as const satisfies ValueSchemaSpec

export type WebMapArgs = InferArgs<typeof WEB_MAP_PARAMETERS>
export type WebMapOutput = InferValue<typeof WEB_MAP_OUTPUT_SCHEMA>
export type WebMapOutputAttempt = WebMapOutput['attempts'][number]
export type WebMapWarning = WebMapOutput['warnings'][number]

export type WebSearchArgs = InferArgs<typeof WEB_SEARCH_PARAMETERS>
export type WebSearchOutput = InferValue<typeof WEB_SEARCH_OUTPUT_SCHEMA>
export type DocsSearchArgs = InferArgs<typeof DOCS_SEARCH_PARAMETERS>
export type DocsSearchOutput = InferValue<typeof DOCS_SEARCH_OUTPUT_SCHEMA>
export type SearchSourcesArgs = InferArgs<typeof SEARCH_SOURCES_PARAMETERS>
export type SearchSourcesOutput = InferValue<typeof SEARCH_SOURCES_OUTPUT_SCHEMA>
export type WebSearchVisibleSource = WebSearchOutput['sources'][number]
export type WebSearchWarning = WebSearchOutput['warnings'][number]
export type DocsSearchSnippet = DocsSearchOutput['snippets'][number]
export type DocsSearchWarning = DocsSearchOutput['warnings'][number]
export type DocsSearchSelectedLibrary = NonNullable<DocsSearchOutput['selected_library']>
export type SearchSourcesFound = Extract<SearchSourcesOutput, { state: 'found' }>
export type SearchSourcesPageSource = SearchSourcesFound['sources'][number]
