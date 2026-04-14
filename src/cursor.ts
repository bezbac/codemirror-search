import {Text, TextIterator, codePointAt, codePointSize, fromCodePoint} from "@codemirror/state"

const basicNormalize: (string: string) => string = typeof String.prototype.normalize == "function"
  ? x => x.normalize("NFKD") : x => x

const extendingChar = (() => {
  try {
    return new RegExp("^\\p{M}", "u")
  } catch {
    return null
  }
})()

/// A search cursor provides an iterator over text matches in a
/// document.
export class SearchCursor implements Iterator<{from: number, to: number}>{
  private iter: TextIterator
  /// The current match (only holds a meaningful value after
  /// [`next`](#search.SearchCursor.next) has been called and when
  /// `done` is false).
  value = {from: 0, to: 0}
  /// Whether the end of the iterated region has been reached.
  done = false
  private matches: number[] = []
  // Matches may complete before the end of a normalized expansion,
  // such as a query for "セン" matching inside "㌢" -> "センチ".
  private pending: {from: number, to: number}[] = []
  private buffer = ""
  private bufferPos = 0
  private bufferStart: number
  private normalize: (string: string) => string
  private query: string

  /// Create a text cursor. The query is the search string, `from` to
  /// `to` provides the region to search.
  ///
  /// When `normalize` is given, it will be called, on both the query
  /// string and the content it is matched against, before comparing.
  /// You can, for example, create a case-insensitive search by
  /// passing `s => s.toLowerCase()`.
  ///
  /// Text is always normalized with
  /// [`.normalize("NFKD")`](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/String/normalize)
  /// (when supported).
  constructor(text: Text, query: string,
              from: number = 0, to: number = text.length,
              normalize?: (string: string) => string,
              private test?: (from: number, to: number, buffer: string, bufferPos: number) => boolean) {
    this.iter = text.iterRange(from, to)
    this.bufferStart = from
    this.normalize = normalize ? x => normalize(basicNormalize(x)) : basicNormalize
    this.query = this.normalize(query)
  }

  private peek() {
    if (this.bufferPos == this.buffer.length) {
      this.bufferStart += this.buffer.length
      this.iter.next()
      if (this.iter.done) return -1
      this.bufferPos = 0
      this.buffer = this.iter.value
    }
    return codePointAt(this.buffer, this.bufferPos)
  }

  /// Look for the next match. Updates the iterator's
  /// [`value`](#search.SearchCursor.value) and
  /// [`done`](#search.SearchCursor.done) properties. Should be called
  /// at least once before using the cursor.
  next() {
    while (this.matches.length) this.matches.pop()
    while (this.pending.length) this.pending.pop()
    return this.nextOverlapping()
  }

  /// The `next` method will ignore matches that partially overlap a
  /// previous match. This method behaves like `next`, but includes
  /// such matches.
  nextOverlapping() {
    if (this.pending.length) {
      this.value = this.pending.shift()!
      return this
    }
    for (;;) {
      let next = this.peek()
      if (next < 0) {
        this.done = true
        return this
      }
      let str = fromCodePoint(next), start = this.bufferStart + this.bufferPos
      this.bufferPos += codePointSize(next)
      let norm = this.normalize(str)
      if (norm.length) for (let i = 0, pos = start;; i++) {
        let code = norm.charCodeAt(i)
        let match = this.match(code, pos, this.bufferPos + this.bufferStart)
        if (match && this.endsAtNormalizationBoundary(norm, i + 1)) {
          // Avoid returning the same source range twice from one expansion.
          let last = this.pending[this.pending.length - 1]
          if (!last || last.from != match.from || last.to != match.to) this.pending.push(match)
        }
        if (i == norm.length - 1) break
        if (pos == start && i < str.length && str.charCodeAt(i) == code) pos++
      }
      if (this.pending.length) {
        this.value = this.pending.shift()!
        return this
      }
    }
  }

  private endsAtNormalizationBoundary(norm: string, index: number) {
    if (index >= norm.length) return true
    let next = norm.charCodeAt(index)
    // Don't stop inside a surrogate pair or before trailing combining marks.
    return (next < 0xdc00 || next > 0xdfff) &&
      !(extendingChar && extendingChar.test(fromCodePoint(codePointAt(norm, index))))
  }

  private match(code: number, pos: number, end: number) {
    let match: null | {from: number, to: number} = null
    for (let i = 0; i < this.matches.length; i += 2) {
      let index = this.matches[i], keep = false
      if (this.query.charCodeAt(index) == code) {
        if (index == this.query.length - 1) {
          match = {from: this.matches[i + 1], to: end}
        } else {
          this.matches[i]++
          keep = true
        }
      }
      if (!keep) {
        this.matches.splice(i, 2)
        i -= 2
      }
    }
    if (this.query.charCodeAt(0) == code) {
      if (this.query.length == 1)
        match = {from: pos, to: end}
      else
        this.matches.push(1, pos)
    }
    if (match && this.test && !this.test(match.from, match.to, this.buffer, this.bufferStart)) match = null
    return match
  }

  declare [Symbol.iterator]: () => Iterator<{from: number, to: number}>
}

if (typeof Symbol != "undefined")
  SearchCursor.prototype[Symbol.iterator] = function(this: SearchCursor) { return this }
