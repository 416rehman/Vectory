#!/bin/sh
# Produces a local repository; never uploads or publishes it.
set -eu
if [ "$#" -ne 3 ]; then
  echo 'usage: build-apt-repository.sh DEB_DIRECTORY NEW_OUTPUT_DIRECTORY GPG_KEY_ID' >&2
  exit 2
fi
deb_dir=$1
repo_dir=$2
key_id=$3
test ! -e "$repo_dir"
mkdir -p "$repo_dir/pool/main" "$repo_dir/dists/stable/main/binary-amd64" "$repo_dir/dists/stable/main/binary-arm64"
cp "$deb_dir"/*.deb "$repo_dir/pool/main/"
(
  cd "$repo_dir"
  for arch in amd64 arm64; do
    dpkg-scanpackages --arch "$arch" pool/main /dev/null > "dists/stable/main/binary-$arch/Packages"
    gzip -n -9 -k "dists/stable/main/binary-$arch/Packages"
  done
  apt-ftparchive -o APT::FTPArchive::Release::Origin=Vectory \
    -o APT::FTPArchive::Release::Label=Vectory \
    -o APT::FTPArchive::Release::Suite=stable \
    -o APT::FTPArchive::Release::Codename=stable \
    -o APT::FTPArchive::Release::Architectures='amd64 arm64' \
    -o APT::FTPArchive::Release::Components=main release dists/stable > dists/stable/Release
  gpg --batch --yes --local-user "$key_id" --armor --detach-sign --output dists/stable/Release.gpg dists/stable/Release
  gpg --batch --yes --local-user "$key_id" --clearsign --output dists/stable/InRelease dists/stable/Release
  gpg --batch --export "$key_id" > vectory-archive-keyring.gpg
)
echo 'Signed local APT repository created. Publication and independent key distribution remain separate steps.'
