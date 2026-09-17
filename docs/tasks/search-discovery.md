Search + Discovery Improvements

I want to improve the Search and Discover experience in my existing Next.js movie/TV streaming application.

Before modifying code, inspect the existing implementation and identify:

* how movie search currently works
* how TV/show search currently works
* which metadata provider/API is being used
* existing API routes/endpoints
* existing home/discover functionality
* how movie/show detail pages are routed
* how navigation/back behavior currently works
* whether search/filter state currently exists only in React state
* whether TMDB IDs or equivalent stable media IDs are already used

Do not unnecessarily rewrite working functionality.

The main goals are:

1. Search both movies AND TV shows.
2. Add filtering by media type.
3. Add filtering by genre.
4. Improve Discover with movie/show and genre filters.
5. Add proper Search and Discover routes/endpoints.
6. Preserve Search/Discover state when opening a title and navigating back.
7. Make the architecture reusable by a future Android TV client.

⸻

1. SEARCH BOTH MOVIES AND TV SHOWS

Currently improve Search so a normal search can return both:

* Movies
* TV Shows / Series

Example:

Search:
Alien

Results could contain:

[Movie] Alien
[Movie] Aliens
[TV] Alien: Earth
…

If NO media-type filter is selected:

Search BOTH movies and TV shows.

Do not require separate movie and TV searches from the user.

Results must clearly identify whether an item is:

Movie

or:

TV Show

Use a normalized media representation internally where appropriate.

For example:

{
id,
mediaType: “movie” | “tv”,
title,
originalTitle,
poster,
backdrop,
overview,
year,
genreIds,
rating,
popularity
}

Do not blindly use this exact structure if the application already has an appropriate normalized media model.

⸻

2. MEDIA TYPE FILTER

Add a Search filter for:

All
Movies
TV Shows

Default:

All

Behavior:

All
→ search movies + TV shows

Movies
→ movies only

TV Shows
→ TV shows only

The selected filter should be represented in the URL.

For example:

/search?q=alien

/search?q=alien&type=movie

/search?q=alien&type=tv

Use appropriate Next.js routing/query parameter conventions for the existing project.

The URL should be the source of truth for important Search state where practical.

⸻

3. GENRE FILTER

Add genre filtering.

Examples:

Action
Adventure
Animation
Comedy
Crime
Documentary
Drama
Family
Fantasy
History
Horror
Music
Mystery
Romance
Science Fiction
Thriller
War
Western

For TV shows, use the genres actually supported by the metadata provider.

Do NOT assume movie and TV genre IDs are identical.

Fetch/use the provider’s correct movie and TV genre definitions.

The UI can display human-friendly names while internally using the provider’s genre IDs.

Allow:

All Genres

as the default.

Example:

Search:
alien

Type:
Movies

Genre:
Horror

The results should contain movies matching the query and selected genre.

Another example:

Search:
office

Type:
TV Shows

Genre:
Comedy

The results should contain matching TV shows.

If:

Type = All
Genre = Horror

search/filter BOTH movies and TV shows appropriately.

⸻

4. MULTIPLE GENRES

Inspect the existing UI and architecture and determine whether supporting multiple genres is clean.

If it is straightforward, support selecting multiple genres.

Example:

Horror + Science Fiction

If multiple genres introduce unnecessary complexity for the first implementation, implement one genre filter cleanly but structure the API so multiple genre IDs can be supported later.

Do not implement a fragile UI just to support multiple selection.

⸻

5. SEARCH API ENDPOINT

Create or improve a dedicated application endpoint for Search.

Conceptually:

GET /api/search

Parameters could include:

q
type
genre
page

Example:

GET /api/search?q=alien

GET /api/search?q=alien&type=movie

GET /api/search?q=alien&type=tv

GET /api/search?q=alien&type=movie&genre=27

The exact endpoint/parameter structure should follow the existing project’s conventions.

Do not expose third-party API credentials to the browser.

The browser should call OUR backend.

Our backend should call the metadata provider.

Conceptually:

Web / Android TV
↓
GET /api/search
↓
Our Next.js server
↓
Metadata provider

This is important because I plan to build an Android TV client later.

⸻

6. SEARCH PAGINATION

Support pagination correctly.

Do not load an unnecessarily huge result set at once.

The Search API should return enough pagination information for the UI.

For example:

{
results: […],
page: 1,
totalPages: 20,
totalResults: 390
}

Use the metadata provider’s real pagination behavior.

The UI can use either:

* Load More
* pagination
* infinite scrolling

Choose whichever fits the existing UI best.

Most importantly, preserve the current page/results position when navigating back from a movie/show.

⸻

7. SEARCH URL STATE

Search state must survive navigation.

Example:

User visits:

/search?q=alien&type=movie&genre=horror&page=2

They scroll down and open a movie.

They press Back.

EXPECTED:

Return to:

/search?q=alien&type=movie&genre=horror&page=2

with the same:

* search query
* media-type filter
* genre
* page
* results
* ideally scroll position

DO NOT send the user back to the Home page.

Do not store important Search state only in temporary component state if that causes it to disappear during navigation.

⸻

8. SEARCH RESULT NAVIGATION

Movie results should navigate to the existing movie detail route.

TV results should navigate to the existing TV/show detail route.

For example, conceptually:

/movie/{id}

/tv/{id}

Use the routes already established by the project rather than inventing duplicate detail pages.

Browser Back should naturally return to Search because Search has its own URL.

Avoid custom back-button hacks if proper routing solves the problem.

⸻

9. DISCOVER PAGE

Create a dedicated Discover experience.

It should have its own route:

/discover

The exact route can follow existing project conventions.

Discover should NOT require a text search.

The user should be able to browse content using filters.

At minimum:

Media Type:
All
Movies
TV Shows

Genre:
All Genres
Action
Comedy
Crime
Drama
Horror
etc.

Potential future filters could include:

* release year
* rating
* popularity
* language
* sort order

Do NOT overbuild these unless they fit naturally.

Focus first on:

MEDIA TYPE + GENRE.

⸻

10. DISCOVER BEHAVIOR

Examples:

/discover

→ discover movies + TV shows

/discover?type=movie

→ discover movies

/discover?type=tv

→ discover TV shows

/discover?genre=horror

→ discover movies + TV shows in Horror

/discover?type=movie&genre=horror

→ discover Horror movies

/discover?type=tv&genre=comedy

→ discover Comedy TV shows

Use provider genre IDs internally where appropriate rather than relying on English genre strings for API calls.

The URLs above are conceptual. Choose a clean implementation consistent with the application.

⸻

11. DISCOVER API ENDPOINT

Create a dedicated backend endpoint for discovery.

Conceptually:

GET /api/discover

Supported parameters should include:

type
genre
page

Potentially:

sort

if useful.

Examples:

GET /api/discover

GET /api/discover?type=movie

GET /api/discover?type=tv

GET /api/discover?genre=27

GET /api/discover?type=movie&genre=27&page=2

Again, use the project’s existing API conventions where appropriate.

The client should NOT directly depend on third-party metadata API credentials.

⸻

12. DISCOVER ALL — MOVIES + TV

If:

type = all

the application needs to combine movie and TV discovery results.

Do this intelligently.

Do not simply show 20 movies followed by 20 TV shows if it produces poor UX.

Normalize the results and combine/interleave them based on an appropriate provider ranking such as popularity or the provider’s discovery ordering.

Preserve:

mediaType

for every result so clicking it opens the correct detail page.

Be careful comparing ranking fields from separate movie and TV API responses. If the provider does not provide a directly comparable cross-media ranking, document the merge strategy rather than pretending the ordering is globally authoritative.

⸻

13. GENRE DIFFERENCES

Movie and TV genres may differ.

Create a clean genre abstraction.

For example, the UI could know:

{
name: “Comedy”,
movieGenreId: …,
tvGenreId: …
}

or maintain separate provider genre mappings internally.

Do not incorrectly send a movie genre ID to the TV discovery API.

If a genre exists for movies but not TV, or vice versa, handle that gracefully.

⸻

14. DISCOVER SECTIONS

The main Discover page can optionally provide useful sections when no filters are selected.

For example:

Trending
Popular Movies
Popular TV Shows
Horror
Comedy
Action
Drama

However, do not make dozens of unnecessary metadata-provider requests.

Prefer a small number of useful sections and lazy-load where appropriate.

Once the user selects a genre/type filter, switch to the filtered results view.

Example:

Discover

[All] [Movies] [TV Shows]

Genres:
[All] [Action] [Comedy] [Drama] [Horror] […]

Popular Movies
[…]

Popular Shows
[…]

Horror
[…]

Then:

User selects:

TV Shows + Horror

Display:

Horror TV Shows

[…]
[…]

⸻

15. HOME PAGE VS DISCOVER

Keep the responsibilities clear.

HOME:

Quick entry point.

Could contain things such as:

* Trending
* Popular
* Continue Watching later
* Recently Added later

DISCOVER:

Dedicated browsing experience.

SEARCH:

Dedicated text-search experience.

These should be separate routes.

Conceptually:

/
→ Home

/search
→ Search

/discover
→ Discover

/movie/{id}
→ Movie details

/tv/{id}
→ TV details

Do not make Search/Discover temporary Home-page UI modes if that causes navigation state to be lost.

⸻

16. NAVIGATION

Main navigation should provide clear access to:

Home
Search
Discover

Adapt this to the existing navigation design.

When I am on:

Search → Movie → Back

I should return to Search.

When I am on:

Discover Horror → Movie → Back

I should return to Discover Horror.

When I am on:

Discover TV Comedy page 3 → Show → Back

I should return to:

Discover TV Comedy page 3

and ideally the previous scroll position.

⸻

17. SCROLL RESTORATION

Investigate how Next.js/browser history currently handles scroll restoration.

Where practical, preserve scroll position when returning from a movie/show detail page.

Do not introduce a large custom state-management system solely for scroll restoration if native browser/Next.js routing already handles it correctly.

The priority is:

1. Correct route
2. Correct query/filter state
3. Correct page
4. Scroll restoration

⸻

18. LOADING / EMPTY / ERROR STATES

Search and Discover need proper states.

SEARCH EMPTY QUERY:

Do not show a confusing error.

Display appropriate Search UI or suggestions.

NO RESULTS:

Example:

No results found for “xyz”.

FILTER HAS NO RESULTS:

Example:

No Horror TV shows matched this search.

LOADING:

Use the application’s existing loading/skeleton style.

ERROR:

Metadata-provider failure should show a useful retry/error state rather than breaking the page.

⸻

19. SEARCH DEBOUNCING

If Search currently searches while typing, debounce requests appropriately.

Do not issue:

a
al
ali
alie
alien

as expensive overlapping searches unnecessarily.

Cancel/ignore obsolete requests.

However, do not make typing feel sluggish.

If Search currently requires pressing Enter/Search, preserve that behavior unless changing it clearly improves the existing UX.

⸻

20. RESPONSIVE / TV-FRIENDLY DESIGN

Keep Search and Discover usable with:

* desktop
* mobile
* eventual Android TV

Do not build Android TV code now.

However, avoid UI assumptions that require mouse hover.

Filters/results should eventually be navigable using directional controls.

Cards need clear focus/selection states if the existing UI already supports keyboard navigation.

⸻

21. API ARCHITECTURE FOR FUTURE ANDROID TV

The backend Search/Discover API should be reusable independently of the Next.js web UI.

Eventually:

Web App ──────┐
↓
Search/Discover API
↑
Android TV ───┘
↓
Metadata provider

Do not place essential Search/Discover logic only inside React components.

Keep:

provider integration
normalization
filter handling
pagination

in reusable server-side modules.

⸻

22. CACHING

Inspect whether metadata-provider requests are currently cached.

Add reasonable caching for data that does not need to be fetched constantly, especially:

* genre definitions
* discover results where appropriate
* repeated identical searches for a short period if useful

Do not aggressively cache search results if it creates stale/broken behavior.

Follow the metadata provider’s requirements.

⸻

23. TESTS

Add tests for at least:

SEARCH:

* query searches movies + TV when type=all
* movie-only search
* TV-only search
* genre filtering
* movie genre mapping
* TV genre mapping
* pagination
* normalization
* empty query
* no results
* provider error

DISCOVER:

* discover all
* movies only
* TV only
* movie genre
* TV genre
* genre + type
* pagination
* result normalization
* provider error

NAVIGATION/STATE where practical:

* Search URL contains query
* Search URL contains filters
* Discover URL contains filters
* movie result links to movie detail
* TV result links to TV detail
* Back navigation preserves Search route/state
* Back navigation preserves Discover route/state

Do not make automated tests depend unnecessarily on the live metadata provider.

Mock external API calls where appropriate.

⸻

24. DO NOT BREAK EXISTING FEATURES

These changes must not break:

* movie detail pages
* TV/show detail pages
* season/episode selection
* torrent search
* torrent playback
* HTTP Range streaming
* HLS playback
* subtitle functionality
* OpenSubtitles/SubDL work
* season-pack torrents

Search/Discover is for finding MEDIA.

Torrent/source search remains responsible for finding a playable torrent for the selected media.

Keep those responsibilities separate.

The intended flow is:

Search / Discover
↓
Movie or TV Show
↓
Detail page
↓
Episode selection if TV
↓
Torrent/source search
↓
Playback

Do NOT mix torrent results directly into general media Search unless the application already intentionally works that way.

⸻

25. STAGE 1 — AUDIT FIRST

Before modifying code, report:

1. Current Search architecture.
2. Current Discover/Home architecture.
3. Current metadata provider.
4. Current API routes.
5. Current movie/TV routing.
6. Why Back currently returns to Home.
7. Current genre support.
8. Current pagination support.
9. Components/modules that need modification.
10. Proposed Search API.
11. Proposed Discover API.
12. Proposed URL structure.
13. Proposed genre architecture.
14. How movie + TV results will be normalized.
15. How navigation state will be preserved.

Then implement.

⸻

26. STAGE 2 — IMPLEMENTATION

After the audit, implement the feature.

When complete, report:

* files added
* files modified
* Search endpoint
* Discover endpoint
* supported parameters
* Search UI changes
* Discover UI changes
* genre implementation
* movie/TV normalization
* pagination behavior
* URL/navigation behavior
* Back-button behavior
* caching
* tests added
* test results
* remaining limitations

Run the relevant tests and fix regressions introduced by the changes.

Most importantly, the final UX should behave like this:

SEARCH:

Search “alien”
→ movies + shows

Search “alien”
Type: Movies
→ movies only

Search “alien”
Genre: Horror
→ Horror movies + Horror TV shows

Search “alien”
Type: Movies
Genre: Horror
→ Horror movies only

DISCOVER:

Discover
→ movies + TV

Discover
Genre: Horror
→ Horror movies + Horror TV

Discover
Type: TV Shows
Genre: Comedy
→ Comedy TV shows

NAVIGATION:

Search
→ apply filters
→ scroll results
→ open movie
→ Back
→ SAME SEARCH + SAME FILTERS

Discover
→ Horror
→ Movies
→ page 2
→ open movie
→ Back
→ SAME DISCOVER FILTERS + PAGE

Do not return to Home and lose the user’s browsing context.