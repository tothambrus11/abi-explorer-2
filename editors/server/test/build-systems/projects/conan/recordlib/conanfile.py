from conan import ConanFile
from conan.tools.files import copy


class RecordLib(ConanFile):
    """A header-only package whose define changes Record's layout."""

    name = "recordlib"
    version = "1.0"
    exports_sources = "include/*"
    no_copy_source = True

    def package(self):
        copy(self, "*.h", self.source_folder, self.package_folder)

    def package_info(self):
        self.cpp_info.bindirs = []
        self.cpp_info.libdirs = []
        self.cpp_info.defines = ["RECORD_WIDE_ID"]

    def package_id(self):
        self.info.clear()
