"""Song database (SQLite, stdlib only).

Stores the raw ChordPro source as the source of truth, plus denormalized
metadata for listing/search. Parsing happens on load so the on-disk format
stays human-editable and re-parsable. This schema ports directly to the
Tauri app (Rust `rusqlite` / `sqlx`) later.
"""

import sqlite3
from song import parse_chordpro

DB_PATH = "ukejam.db"

SCHEMA = """
CREATE TABLE IF NOT EXISTS songs (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    title     TEXT NOT NULL,
    artist    TEXT NOT NULL DEFAULT '',
    song_key  TEXT NOT NULL DEFAULT '',
    source    TEXT NOT NULL,                -- raw ChordPro text (source of truth)
    created   TEXT NOT NULL DEFAULT (datetime('now')),
    updated   TEXT NOT NULL DEFAULT (datetime('now'))
);
"""


def connect(path=DB_PATH):
    conn = sqlite3.connect(path)
    conn.row_factory = sqlite3.Row
    conn.executescript(SCHEMA)
    return conn


def add_song(conn, source):
    """Parse + store a ChordPro song. Returns the new row id."""
    song = parse_chordpro(source)
    cur = conn.execute(
        "INSERT INTO songs (title, artist, song_key, source) VALUES (?,?,?,?)",
        (song.title, song.artist, song.key, source),
    )
    conn.commit()
    return cur.lastrowid


def update_song(conn, song_id, source):
    song = parse_chordpro(source)
    conn.execute(
        "UPDATE songs SET title=?, artist=?, song_key=?, source=?, "
        "updated=datetime('now') WHERE id=?",
        (song.title, song.artist, song.key, source, song_id),
    )
    conn.commit()


def delete_song(conn, song_id):
    conn.execute("DELETE FROM songs WHERE id=?", (song_id,))
    conn.commit()


def list_songs(conn):
    return conn.execute(
        "SELECT id, title, artist, song_key FROM songs ORDER BY title"
    ).fetchall()


def get_song(conn, song_id):
    """Return a parsed Song object (with .lines, .chord_sequence)."""
    row = conn.execute("SELECT source FROM songs WHERE id=?",
                       (song_id,)).fetchone()
    return parse_chordpro(row["source"]) if row else None


if __name__ == "__main__":
    # In-memory demo so we don't litter a db file during the smoke test.
    conn = connect(":memory:")
    sid = add_song(conn, """{title: Riptide}
{artist: Vance Joy}
{key: Am}
[Am]I was scared of [G]dentists and the [C]dark""")
    sid2 = add_song(conn, """{title: Three Little Birds}
{artist: Bob Marley}
[A]Don't worry [D]about a [A]thing""")
    print("library:")
    for r in list_songs(conn):
        print(f"  #{r['id']} {r['title']} — {r['artist']} ({r['song_key']})")
    print("\nload #1:")
    song = get_song(conn, sid)
    print("  sequence:", song.chord_sequence)
    print("  unique  :", song.unique_chords)
