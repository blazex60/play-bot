import { Database as BunDatabase } from 'bun:sqlite'

/**
 * better-sqlite3-compatible wrapper around bun:sqlite so `bun test` can
 * exercise the same DB code paths as Node production (which still uses
 * better-sqlite3; bun cannot load that native addon).
 */
export default class Database {
  /** @param {string} filename */
  constructor(filename) {
    this.#inner = new BunDatabase(filename)
  }

  /** @type {import('bun:sqlite').Database} */
  #inner

  /**
   * @param {string} source
   * @returns {unknown}
   */
  pragma(source) {
    return this.#inner.prepare(`PRAGMA ${source}`).all()
  }

  /**
   * @param {string} sql
   * @returns {this}
   */
  exec(sql) {
    this.#inner.exec(sql)
    return this
  }

  /**
   * @param {string} sql
   * @returns {import('bun:sqlite').Statement}
   */
  prepare(sql) {
    return this.#inner.prepare(sql)
  }

  /**
   * @template {(...args: never[]) => unknown} T
   * @param {T} fn
   * @returns {T}
   */
  transaction(fn) {
    return this.#inner.transaction(fn)
  }

  close() {
    this.#inner.close()
  }
}
