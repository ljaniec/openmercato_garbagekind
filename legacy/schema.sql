-- Schemat "legacy" sortowni.
-- Nazwy tabel i kolumn sa celowo przepisane z webERP (wraz z jego dziwactwami:
-- kontrahent to "debtor"), zeby klient napisany przeciw temu systemowi dzialal
-- przeciw prawdziwej instancji webERP po zmianie jednego URL-a.

DROP TABLE IF EXISTS salesorders;
DROP TABLE IF EXISTS stockmoves;
DROP TABLE IF EXISTS locstock;
DROP TABLE IF EXISTS locations;
DROP TABLE IF EXISTS stockmaster;
DROP TABLE IF EXISTS debtorsmaster;

-- Kontrahenci: dostawcy i odbiorcy w jednej tabeli (jak w webERP).
CREATE TABLE debtorsmaster (
    debtorno     TEXT PRIMARY KEY,
    name         TEXT NOT NULL,
    address1     TEXT NOT NULL,   -- ulica
    address2     TEXT NOT NULL,   -- miasto
    debtortype   TEXT NOT NULL,   -- DOS = dostawca, ODB = odbiorca
    currcode     TEXT NOT NULL,
    clientsince  TEXT NOT NULL,   -- YYYY-MM-DD
    creditlimit  REAL NOT NULL,
    taxref       TEXT NOT NULL DEFAULT ''  -- NIP; w webERP tez nazywa sie taxref
);

-- Frakcje odpadow jako pozycje magazynowe.
CREATE TABLE stockmaster (
    stockid       TEXT PRIMARY KEY,
    description   TEXT NOT NULL,
    categoryid    TEXT NOT NULL,
    units         TEXT NOT NULL,  -- legacy trzyma masy w kilogramach
    actualcost    REAL NOT NULL,
    decimalplaces INTEGER NOT NULL
);

-- Boksy i magazyny.
CREATE TABLE locations (
    loccode      TEXT PRIMARY KEY,
    locationname TEXT NOT NULL,
    deladd1      TEXT NOT NULL
);

-- Stany magazynowe (frakcja x lokalizacja).
CREATE TABLE locstock (
    stockid  TEXT NOT NULL REFERENCES stockmaster(stockid),
    loccode  TEXT NOT NULL REFERENCES locations(loccode),
    quantity REAL NOT NULL,        -- kg
    PRIMARY KEY (stockid, loccode)
);

-- Ksiega ruchow: serce systemu.
-- type: PZ = przyjecie odpadu, SORT = wysortowanie frakcji, WZ = wydanie do odbiorcy.
-- UWAGA: prawdziwy webERP uzywa w tym miejscu numerycznych systypes.
-- Skroty literowe to swiadome uproszczenie mocka.
CREATE TABLE stockmoves (
    stkmoveno    INTEGER PRIMARY KEY,
    stockid      TEXT NOT NULL REFERENCES stockmaster(stockid),
    type         TEXT NOT NULL,
    loccode      TEXT NOT NULL REFERENCES locations(loccode),
    trandate     TEXT NOT NULL,    -- ISO 8601, sekundowa rozdzielczosc
    debtorno     TEXT,             -- NULL dla ruchow wewnetrznych (SORT)
    qty          REAL NOT NULL,    -- kg; WZ jest ujemne (konwencja webERP)
    standardcost REAL NOT NULL,
    orderno      INTEGER           -- WZ wskazuje zamowienie; NULL dla PZ i SORT
);
CREATE INDEX idx_stockmoves_trandate ON stockmoves(trandate);

-- Wplaty odbiorcow. W webERP rozrachunki z odbiorcami siedza w `debtortrans`
-- i tam tez trafiaja faktury oraz zaplaty; tutaj wystarcza same zaplaty.
CREATE TABLE debtortrans (
    transno   INTEGER PRIMARY KEY,
    debtorno  TEXT NOT NULL REFERENCES debtorsmaster(debtorno),
    orderno   INTEGER REFERENCES salesorders(orderno),
    transdate TEXT NOT NULL,    -- YYYY-MM-DD
    type      TEXT NOT NULL,    -- ZAPL = wplata odbiorcy
    amount    REAL NOT NULL     -- brutto w PLN
);

-- Wydania do odbiorcy.
CREATE TABLE salesorders (
    orderno      INTEGER PRIMARY KEY,
    debtorno     TEXT NOT NULL REFERENCES debtorsmaster(debtorno),
    orddate      TEXT NOT NULL,
    deliverydate TEXT NOT NULL,
    stockid      TEXT NOT NULL REFERENCES stockmaster(stockid),
    qty          REAL NOT NULL,    -- kg, dodatnie
    unitprice    REAL NOT NULL
);
