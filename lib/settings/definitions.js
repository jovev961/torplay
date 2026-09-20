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
    id: "jackett",
    section: "services",
    name: "Jackett",
    required: false,
    description: "Searches configured Torznab indexers for authorized movie and TV sources.",
    helpUrl: "http://localhost:9117/UI/Dashboard",
    helpText: "Open the Jackett dashboard on the TorPlay computer and copy the API key shown in the header.",
    fields: [
      { id: "url", environment: "JACKETT_URL", label: "Base URL", kind: "url", required: true, defaultValue: "http://localhost:9117" },
      { id: "apiKey", environment: "JACKETT_API_KEY", label: "API key", secret: true, required: true },
      { id: "movieIndexers", environment: "JACKETT_MOVIE_INDEXERS", label: "Movie indexer IDs", kind: "indexers" },
      { id: "showIndexers", environment: "JACKETT_SHOW_INDEXERS", label: "TV indexer IDs", kind: "indexers" },
    ],
  },
  {
    id: "omdb",
    section: "services",
    name: "OMDb",
    required: false,
    description: "Supports IMDb-based metadata lookups and Jackett searches that only provide an IMDb ID.",
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
