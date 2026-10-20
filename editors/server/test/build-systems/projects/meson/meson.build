project('record_meson', 'cpp', default_options: ['cpp_std=c++17'])
executable(
  'record',
  'src/main.cpp',
  include_directories: include_directories('include'),
  cpp_args: ['-DRECORD_WIDE_ID'],
)
