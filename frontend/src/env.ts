// The development copy runs on test data and has no saving job; say so, so it is never mistaken
// for the real site.
export const LOCAL = ["localhost", "127.0.0.1"].includes(location.hostname);
