// English function words carry no topic. Deliberately short: everything else
// is left to IDF. Used where a match must rest on real shared terms (lesson
// selection, past-session evidence) — never inside tokenize(), whose output
// must stay identical at index and query time.
export const STOPWORDS: ReadonlySet<string> = new Set(('a an and are as at be but by can could do does for from had has have how i if in into is it its '
  + 'me my no not of on or our should so than that the their then there these they this to use used using was we were what '
  + 'when where which who why will with would you your').split(' '));
