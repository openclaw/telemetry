-- No identifiers, request records, timestamps, dimensions or geography.
CREATE TABLE installation_counts (
    day INTEGER NOT NULL CHECK (typeof(day) = 'integer' AND day BETWEEN 0 AND 99999999),
    gap INTEGER NOT NULL CHECK (typeof(gap) = 'integer' AND gap BETWEEN 1 AND 31),
    reports INTEGER NOT NULL CHECK (typeof(reports) = 'integer' AND reports BETWEEN 1 AND 9007199254740991),
    PRIMARY KEY (day, gap)
) WITHOUT ROWID;
