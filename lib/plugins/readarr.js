"use strict";
// Readarr: library size (authors), download queue, missing books and health warnings (*arr API v1).
const { make } = require("./lidarr");
const L = (de, en) => ({ de, en });

module.exports = make({ kind: "readarr", label: "Readarr", match: /readarr/, repo: "Readarr/Readarr", library: "author", libraryLabel: L("Autoren", "Authors") });
