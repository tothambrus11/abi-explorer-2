#pragma once
#include <cstdint>
#include <string>

struct Shape {
  virtual ~Shape();
  std::uint8_t kind;
  double area;
  std::string name;
};
