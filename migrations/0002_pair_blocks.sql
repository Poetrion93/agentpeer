-- (from, recipient) pair block: events cannot express "blocked until".
CREATE TABLE IF NOT EXISTS pair_blocks (
  from_addr TEXT NOT NULL,
  recipient TEXT NOT NULL,
  blocked_until INTEGER NOT NULL,
  PRIMARY KEY (from_addr, recipient)
);
