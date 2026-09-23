export const SETTINGS_PROVIDERS = [
  {
    id: "tmdb",
    section: "services",
    name: "TMDB",
    required: true,
    description: "Provides movie and TV metadata, posters, search, discovery, and episode information.",
    helpUrl: "https://developer.themoviedb.org/docs/getting-started",
    helpText: "Create a TMDB account, open Account Settings → API, and copy the API Read Access Token.",
    fields: [
      { id: "apiToken", environment: "TMDB_API_TOKEN", label: "API Read Access Token", secret: true, required: true },
    ],
  },
  {
    id: "flaresolverr",
    section: "services",
    name: "FlareSolverr",
    required: false,
    description: "Optional external service for Cardigann definitions that require browser challenge handling.",
    helpUrl: "https://github.com/FlareSolverr/FlareSolverr",
    helpText: "Run FlareSolverr yourself on this computer or a private LAN address, then enter its base URL.",
    fields: [
      { id: "url", environment: "FLARESOLVERR_URL", label: "Base URL", kind: "url" },
    ],
  },
  {
    id: "omdb",
    section: "services",
    name: "OMDb",
    required: false,
    description: "Provides optional IMDb ratings for catalog cards and metadata lookups.",
    helpUrl: "https://www.omdbapi.com/apikey.aspx",
    helpText: "Request a free or paid OMDb key, then activate it from the email OMDb sends you.",
    fields: [
      { id: "apiKey", environment: "OMDB_API_KEY", label: "API key", secret: true },
    ],
  },
  {
    id: "opensubtitles",
    section: "subtitles",
    name: "OpenSubtitles",
    required: false,
    description: "Finds optional external subtitle tracks when a torrent does not contain a suitable caption file.",
    helpUrl: "https://www.opensubtitles.com/en/consumers",
    helpText: "Create an OpenSubtitles consumer application and copy its API key. Keep the application user agent recognizable.",
    fields: [
      { id: "apiKey", environment: "OPENSUBTITLES_API_KEY", label: "API key", secret: true },
      { id: "userAgent", environment: "OPENSUBTITLES_USER_AGENT", label: "User agent", kind: "userAgent", defaultValue: "TorPlay v0.1" },
    ],
  },
  {
    id: "subdl",
    section: "subtitles",
    name: "SubDL",
    required: false,
    description: "Provides an additional optional source for movie and episode subtitles.",
    helpUrl: "https://subdl.com/api-doc",
    helpText: "Sign in to SubDL, open the API panel, and create a search-and-download API key.",
    fields: [
      { id: "apiKey", environment: "SUBDL_API_KEY", label: "API key", secret: true },
    ],
  },
];

export const SETTINGS_ENVIRONMENT_KEYS = SETTINGS_PROVIDERS.flatMap(
  (provider) => provider.fields.map((field) => field.environment),
);

export function settingsProvider(id) {
  return SETTINGS_PROVIDERS.find((provider) => provider.id === id) || null;
}
