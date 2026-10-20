#include <stdint.h>

struct Reading {
  uint8_t channel;
  uint32_t value;
  unsigned flags : 3;
  unsigned valid : 1;
};
