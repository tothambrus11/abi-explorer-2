#include "shapes.h"
#include <vector>

struct Circle : Shape {
  float radius;
  char tag;
};

struct Packet {
  std::uint8_t type;
  std::uint32_t length;
  std::uint16_t checksum;
  std::vector<int> payload;
};

template <typename T> struct Pair {
  char first;
  T second;
};

Pair<double> wide;
Pair<short> narrow;
