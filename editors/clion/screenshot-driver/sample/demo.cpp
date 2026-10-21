#include <cstdint>

struct Message {
  bool urgent;
  std::uint64_t id;
  char kind;
  std::uint32_t length;
};

Message inbox[64];
