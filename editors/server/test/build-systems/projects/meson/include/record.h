#pragma once
#include <stdint.h>

// RECORD_WIDE_ID comes from the build, so a layout that matches the built
// program's own sizeof shows the build's flags reached the engine.
struct Record {
  char tag;
#ifdef RECORD_WIDE_ID
  uint64_t id;
#else
  uint16_t id;
#endif
  char flag;
};
