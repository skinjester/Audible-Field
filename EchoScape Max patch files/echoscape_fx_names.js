autowatch = 1;
inlets = 1;
outlets = 4;

var SLOTS = [
  { varname: "vst~[12]", outlet: 0 },
  { varname: "vst~", outlet: 1 },
  { varname: "vst~[6]", outlet: 2 },
  { varname: "vst~[7]", outlet: 3 },
];

function cleanName(value) {
  if (value == null || value === "") return "";
  if (value instanceof Array) value = value.join(" ");
  var s = String(value);
  s = s.replace(/\\/g, "/");
  var slash = s.lastIndexOf("/");
  if (slash >= 0) s = s.substring(slash + 1);
  s = s.replace(/^C74_(VST3|VST|AU):/, "");
  s = s.replace(/\.vst3info$/i, "");
  s = s.replace(/\.vst3$/i, "");
  s = s.replace(/\.vst$/i, "");
  s = s.replace(/\.dll$/i, "");
  s = s.replace(/\.component$/i, "");
  return s;
}

function bang() {
  for (var i = 0; i < SLOTS.length; i++) {
    var box = this.patcher.getnamed(SLOTS[i].varname);
    var name = "";
    if (box) {
      try {
        name = cleanName(box.getattr("currentplug"));
      } catch (err) {}
    }
    if (name) outlet(SLOTS[i].outlet, name);
  }
}
